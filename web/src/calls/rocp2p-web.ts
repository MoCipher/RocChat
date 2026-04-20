/**
 * RocChat Web — RocP2P DataChannel Transport
 *
 * Uses RTCPeerConnection for NAT traversal (ICE) only, then sends
 * AES-256-GCM encrypted audio frames over a DataChannel — matching
 * the iOS/Android RocP2P wire format:
 *
 *   magic(1) | seq(8) | ciphertext(N) | tag(16)
 *
 * Key derived from the Double Ratchet shared secret via HKDF-SHA256.
 * The browser cannot do raw UDP, so we use RTCDataChannel as the
 * unreliable transport (ordered=false, maxRetransmits=0).
 *
 * Independent STUN servers — no Google, no surveillance.
 */

const STUN_SERVERS: RTCIceServer[] = [
  { urls: 'stun:stun.stunprotocol.org:3478' },
  { urls: 'stun:stun.nextcloud.com:3478' },
];

const MAGIC_AUDIO = 0x52;
const MAGIC_VIDEO = 0x56;
const NONCE_SIZE = 12; // 4-byte salt + 8-byte counter

export interface RocP2PDelegate {
  onCandidate(candidate: RTCIceCandidate): void;
  onConnected(): void;
  onFailed(reason: string): void;
  onAudioFrame(pcm: ArrayBuffer): void;
  onVideoFrame?(frame: ArrayBuffer): void;
}

export class RocP2PWebTransport {
  private pc: RTCPeerConnection | null = null;
  private dc: RTCDataChannel | null = null;
  private sendKey: CryptoKey | null = null;
  private recvKey: CryptoKey | null = null;
  private sendSalt = new Uint8Array(4);
  private recvSalt = new Uint8Array(4);
  private sendSeq = 0n;
  private delegate: RocP2PDelegate;
  private connected = false;

  constructor(delegate: RocP2PDelegate) {
    this.delegate = delegate;
  }

  /** Start the transport. isInitiator determines who creates the offer. */
  async start(sharedSecret: Uint8Array, isInitiator: boolean): Promise<RTCSessionDescriptionInit | null> {
    // Derive send/recv keys via HKDF (72 bytes: 32 send key + 32 recv key + 4 send salt + 4 recv salt)
    const baseKey = await crypto.subtle.importKey('raw', sharedSecret as BufferSource, 'HKDF', false, ['deriveBits']);
    const derived = new Uint8Array(
      await crypto.subtle.deriveBits(
        {
          name: 'HKDF',
          hash: 'SHA-256',
          salt: new TextEncoder().encode('rocchat-p2p-voice-v1'),
          info: new TextEncoder().encode('rocchat.p2p'),
        },
        baseKey,
        72 * 8,
      ),
    );

    if (isInitiator) {
      this.sendSalt = derived.slice(0, 4);
      this.recvSalt = derived.slice(4, 8);
      this.sendKey = await crypto.subtle.importKey('raw', derived.slice(8, 40), 'AES-GCM', false, ['encrypt']);
      this.recvKey = await crypto.subtle.importKey('raw', derived.slice(40, 72), 'AES-GCM', false, ['decrypt']);
    } else {
      // Responder: swap send/recv
      this.recvSalt = derived.slice(0, 4);
      this.sendSalt = derived.slice(4, 8);
      this.recvKey = await crypto.subtle.importKey('raw', derived.slice(8, 40), 'AES-GCM', false, ['decrypt']);
      this.sendKey = await crypto.subtle.importKey('raw', derived.slice(40, 72), 'AES-GCM', false, ['encrypt']);
    }

    // Create RTCPeerConnection (ICE only — no media tracks)
    this.pc = new RTCPeerConnection({ iceServers: STUN_SERVERS });

    this.pc.onicecandidate = (e) => {
      if (e.candidate) this.delegate.onCandidate(e.candidate);
    };

    this.pc.onconnectionstatechange = () => {
      const state = this.pc?.connectionState;
      if (state === 'connected' && !this.connected) {
        this.connected = true;
        this.delegate.onConnected();
      } else if (state === 'failed' || state === 'disconnected') {
        this.delegate.onFailed(state || 'unknown');
      }
    };

    if (isInitiator) {
      // Create DataChannel (unreliable, unordered — mimics UDP)
      this.dc = this.pc.createDataChannel('rocp2p-audio', {
        ordered: false,
        maxRetransmits: 0,
      });
      this.dc.binaryType = 'arraybuffer';
      this.dc.onmessage = (e) => this.handleIncoming(e.data as ArrayBuffer);
      this.dc.onopen = () => {
        this.connected = true;
        this.delegate.onConnected();
      };

      const offer = await this.pc.createOffer();
      await this.pc.setLocalDescription(offer);
      return offer;
    } else {
      // Wait for DataChannel from remote
      this.pc.ondatachannel = (e) => {
        this.dc = e.channel;
        this.dc.binaryType = 'arraybuffer';
        this.dc.onmessage = (ev) => this.handleIncoming(ev.data as ArrayBuffer);
        this.dc.onopen = () => {
          this.connected = true;
          this.delegate.onConnected();
        };
      };
      return null;
    }
  }

  /** Set remote SDP (offer or answer). */
  async setRemoteDescription(sdp: RTCSessionDescriptionInit): Promise<RTCSessionDescriptionInit | null> {
    if (!this.pc) return null;
    await this.pc.setRemoteDescription(sdp);
    if (sdp.type === 'offer') {
      const answer = await this.pc.createAnswer();
      await this.pc.setLocalDescription(answer);
      return answer;
    }
    return null;
  }

  /** Add a remote ICE candidate. */
  async addIceCandidate(candidate: RTCIceCandidateInit): Promise<void> {
    await this.pc?.addIceCandidate(candidate);
  }

  /** Send an encrypted audio frame over the DataChannel. */
  async sendAudio(pcmData: ArrayBuffer): Promise<void> {
    return this.sendEncrypted(pcmData, MAGIC_AUDIO);
  }

  /** Send an encrypted video frame over the DataChannel. */
  async sendVideo(frameData: ArrayBuffer): Promise<void> {
    return this.sendEncrypted(frameData, MAGIC_VIDEO);
  }

  /** Encrypt and send a frame with the given magic byte. */
  private async sendEncrypted(data: ArrayBuffer, magic: number): Promise<void> {
    if (!this.dc || this.dc.readyState !== 'open' || !this.sendKey) return;

    this.sendSeq++;
    // Nonce: 4-byte salt || 8-byte big-endian counter
    const nonce = new Uint8Array(12);
    nonce.set(this.sendSalt, 0);
    const view = new DataView(nonce.buffer);
    // Write 64-bit counter as two 32-bit values (BigInt not needed for practical ranges)
    const seq = Number(this.sendSeq);
    view.setUint32(4, Math.floor(seq / 0x100000000));
    view.setUint32(8, seq >>> 0);

    const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv: nonce }, this.sendKey, data);

    // Wire format: magic(1) | seq(8) | ciphertext+tag
    const frame = new Uint8Array(1 + 8 + ct.byteLength);
    frame[0] = magic;
    frame.set(nonce.slice(4, 12), 1); // 8-byte seq
    frame.set(new Uint8Array(ct), 9);

    this.dc.send(frame.buffer);
  }

  /** Decrypt and dispatch an incoming frame. */
  private async handleIncoming(data: ArrayBuffer): Promise<void> {
    if (!this.recvKey) return;
    const frame = new Uint8Array(data);
    if (frame.length < 26) return; // 1 magic + 8 seq + 16 tag minimum
    const magic = frame[0];
    if (magic !== MAGIC_AUDIO && magic !== MAGIC_VIDEO) return;

    // Reconstruct nonce
    const nonce = new Uint8Array(12);
    nonce.set(this.recvSalt, 0);
    nonce.set(frame.slice(1, 9), 4);

    const ct = frame.slice(9);
    try {
      const plaintext = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: nonce }, this.recvKey, ct);
      if (magic === MAGIC_AUDIO) {
        this.delegate.onAudioFrame(plaintext);
      } else if (magic === MAGIC_VIDEO) {
        this.delegate.onVideoFrame?.(plaintext);
      }
    } catch {
      // Corrupted or replayed frame — drop silently
    }
  }

  /** Stop and clean up. */
  stop(): void {
    this.dc?.close();
    this.pc?.close();
    this.dc = null;
    this.pc = null;
    this.sendKey = null;
    this.recvKey = null;
    this.connected = false;
    this.sendSeq = 0n;
  }

  get isConnected(): boolean {
    return this.connected;
  }
}
