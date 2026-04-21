/**
 * RocChat Web — Voice-over-WebSocket transport.
 *
 * Mirrors the iOS / Android wire format so calls actually interop:
 *   - 16 kHz mono PCM Int16, captured via Web Audio API
 *   - Encoded as μ-law (G.711-ish, ~64 kbit/s, 2× compression vs. PCM16)
 *   - Wrapped as `[0x01 | mulaw bytes]`, base64'd, sent in
 *     `{type:'call_audio', payload:{callId, targetUserId, seq, frame}}`
 *
 * No SDP. No ICE. No WebRTC. Server only relays the audio packets,
 * so this works through every NAT and matches what iOS already ships.
 *
 * Inbound frames are decoded back to Int16 PCM and queued onto a
 * single AudioBufferSourceNode chain so playback is gap-free.
 */

// ── μ-law codec (G.711). Matches iOS `MuLaw.encode/decode`. ──────────────

const MULAW_BIAS = 0x84;
const MULAW_CLIP = 32635;
const MULAW_DECODE_TABLE = new Int16Array(256);
(() => {
  for (let i = 0; i < 256; i++) {
    let mu = ~i & 0xff;
    let sign = (mu & 0x80) ? -1 : 1;
    let exponent = (mu >> 4) & 0x07;
    let mantissa = mu & 0x0f;
    let sample = ((mantissa << 3) + MULAW_BIAS) << exponent;
    sample -= MULAW_BIAS;
    MULAW_DECODE_TABLE[i] = sign * sample;
  }
})();

function mulawEncodeSample(pcm: number): number {
  let sign = 0;
  if (pcm < 0) { sign = 0x80; pcm = -pcm; }
  if (pcm > MULAW_CLIP) pcm = MULAW_CLIP;
  pcm += MULAW_BIAS;
  let exponent = 7;
  for (let mask = 0x4000; (pcm & mask) === 0 && exponent > 0; mask >>= 1) exponent--;
  const mantissa = (pcm >> (exponent + 3)) & 0x0f;
  return (~(sign | (exponent << 4) | mantissa)) & 0xff;
}

function mulawEncode(pcm: Int16Array): Uint8Array {
  const out = new Uint8Array(pcm.length);
  for (let i = 0; i < pcm.length; i++) out[i] = mulawEncodeSample(pcm[i]);
  return out;
}

function mulawDecode(mulaw: Uint8Array): Int16Array {
  const out = new Int16Array(mulaw.length);
  for (let i = 0; i < mulaw.length; i++) out[i] = MULAW_DECODE_TABLE[mulaw[i]];
  return out;
}

// ── base64 helpers (browsers expose only string atob/btoa) ───────────────

function bytesToBase64(bytes: Uint8Array): string {
  let bin = '';
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin);
}

function base64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

// ── Voice-over-WS session ────────────────────────────────────────────────

export interface VoiceWSConfig {
  ws: WebSocket;
  callId: string;
  targetUserId: string;
}

export class VoiceWS {
  private ws: WebSocket;
  private callId: string;
  private targetUserId: string;

  private audioCtx: AudioContext | null = null;
  private mediaStream: MediaStream | null = null;
  private sourceNode: MediaStreamAudioSourceNode | null = null;
  private processor: ScriptProcessorNode | null = null;
  private muted = false;

  // Playback queue — schedule each incoming buffer back-to-back so audio
  // stays continuous even when frames arrive jittery.
  private playbackCtx: AudioContext | null = null;
  private nextPlaybackTime = 0;
  private seqOut = 0;

  constructor(cfg: VoiceWSConfig) {
    this.ws = cfg.ws;
    this.callId = cfg.callId;
    this.targetUserId = cfg.targetUserId;
  }

  /** Acquire mic + start capture loop. Throws on permission denial. */
  async start(): Promise<void> {
    this.mediaStream = await navigator.mediaDevices.getUserMedia({
      audio: {
        channelCount: 1,
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
      },
      video: false,
    });
    // Capture context runs at the device's native rate; we resample
    // to 16 kHz inside the processor.
    const Ctor = (window.AudioContext || (window as any).webkitAudioContext) as typeof AudioContext;
    this.audioCtx = new Ctor();
    this.playbackCtx = new Ctor({ sampleRate: 16000 });

    this.sourceNode = this.audioCtx.createMediaStreamSource(this.mediaStream);
    // ScriptProcessorNode is deprecated but universally supported and
    // adequate for a 16 kHz mono voice path. Buffer = 4096 samples ≈ 90 ms
    // at the device's native rate; we re-chunk to ~20 ms (320 samples) at
    // 16 kHz so latency stays low and packet loss only nukes one frame.
    this.processor = this.audioCtx.createScriptProcessor(4096, 1, 1);
    const inRate = this.audioCtx.sampleRate;
    const ratio = inRate / 16000;
    let resampleAcc: number[] = [];

    this.processor.onaudioprocess = (ev) => {
      if (this.muted) return;
      const input = ev.inputBuffer.getChannelData(0);
      // Linear resample to 16 kHz mono.
      const targetLen = Math.floor(input.length / ratio);
      for (let i = 0; i < targetLen; i++) {
        const idx = i * ratio;
        const lo = Math.floor(idx);
        const hi = Math.min(lo + 1, input.length - 1);
        const frac = idx - lo;
        const sample = input[lo] * (1 - frac) + input[hi] * frac;
        resampleAcc.push(sample);
      }
      // Emit 20 ms frames (320 samples @ 16 kHz) so wire chunks are small.
      const FRAME = 320;
      while (resampleAcc.length >= FRAME) {
        const chunk = resampleAcc.slice(0, FRAME);
        resampleAcc = resampleAcc.slice(FRAME);
        const pcm = new Int16Array(FRAME);
        for (let i = 0; i < FRAME; i++) {
          const s = Math.max(-1, Math.min(1, chunk[i]));
          pcm[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
        }
        this.sendFrame(pcm);
      }
    };

    this.sourceNode.connect(this.processor);
    // ScriptProcessor only fires onaudioprocess when downstream-connected.
    // Route through a muted gain so we don't echo our own mic to speakers.
    const sink = this.audioCtx.createGain();
    sink.gain.value = 0;
    this.processor.connect(sink);
    sink.connect(this.audioCtx.destination);

    if (this.playbackCtx.state === 'suspended') {
      try { await this.playbackCtx.resume(); } catch { /* user gesture required */ }
    }
    this.nextPlaybackTime = this.playbackCtx.currentTime;
  }

  /** Tear down capture + playback. Safe to call multiple times. */
  stop(): void {
    try { this.processor?.disconnect(); } catch { /* ignore */ }
    try { this.sourceNode?.disconnect(); } catch { /* ignore */ }
    this.processor = null;
    this.sourceNode = null;

    this.mediaStream?.getTracks().forEach(t => { try { t.stop(); } catch { /* ignore */ } });
    this.mediaStream = null;

    if (this.audioCtx && this.audioCtx.state !== 'closed') {
      void this.audioCtx.close().catch(() => undefined);
    }
    this.audioCtx = null;

    if (this.playbackCtx && this.playbackCtx.state !== 'closed') {
      void this.playbackCtx.close().catch(() => undefined);
    }
    this.playbackCtx = null;
    this.nextPlaybackTime = 0;
  }

  setMuted(muted: boolean): void { this.muted = muted; }

  /** Play an incoming `call_audio` payload. Tolerates μ-law (0x01) or raw PCM16 (0x00 / legacy). */
  handleIncomingFrame(frameB64: string): void {
    if (!this.playbackCtx) return;
    let bytes: Uint8Array;
    try { bytes = base64ToBytes(frameB64); } catch { return; }
    if (bytes.length === 0) return;

    let pcm: Int16Array;
    const tag = bytes[0];
    if (tag === 0x01) {
      pcm = mulawDecode(bytes.subarray(1));
    } else if (tag === 0x00) {
      pcm = new Int16Array(bytes.buffer, bytes.byteOffset + 1, (bytes.length - 1) >> 1);
    } else {
      // Legacy: raw PCM16 with no tag (older iOS builds).
      pcm = new Int16Array(bytes.buffer, bytes.byteOffset, bytes.length >> 1);
    }
    if (pcm.length === 0) return;

    const buf = this.playbackCtx.createBuffer(1, pcm.length, 16000);
    const channel = buf.getChannelData(0);
    for (let i = 0; i < pcm.length; i++) channel[i] = pcm[i] / 0x8000;

    const node = this.playbackCtx.createBufferSource();
    node.buffer = buf;
    node.connect(this.playbackCtx.destination);

    const now = this.playbackCtx.currentTime;
    if (this.nextPlaybackTime < now) this.nextPlaybackTime = now;
    node.start(this.nextPlaybackTime);
    this.nextPlaybackTime += buf.duration;
  }

  private sendFrame(pcm: Int16Array): void {
    if (this.ws.readyState !== WebSocket.OPEN) return;
    const mulaw = mulawEncode(pcm);
    const tagged = new Uint8Array(mulaw.length + 1);
    tagged[0] = 0x01;
    tagged.set(mulaw, 1);
    this.seqOut = (this.seqOut + 1) >>> 0;
    const msg = {
      type: 'call_audio',
      payload: {
        callId: this.callId,
        targetUserId: this.targetUserId,
        seq: this.seqOut,
        frame: bytesToBase64(tagged),
      },
    };
    try { this.ws.send(JSON.stringify(msg)); } catch { /* socket closed */ }
  }
}
