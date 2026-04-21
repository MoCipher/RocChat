/**
 * RocChat Web — Video-over-WebSocket transport.
 *
 * Mirrors the iOS / Android wire format so 1:1 video calls interop:
 *   - 320×240 @ 8 fps, JPEG-encoded via OffscreenCanvas
 *   - Wrapped as `[0x01 | jpeg bytes]`, base64'd, sent in
 *     `{type:'call_video', payload:{callId, targetUserId, seq, frame}}`
 *
 * No SDP. No WebRTC. Server only relays bytes. Bandwidth ≈ 100 KB/s
 * which is acceptable on Wi-Fi/LTE and matches what native ships.
 *
 * Inbound JPEGs are decoded into <img> elements that an external
 * consumer (the call overlay) can render.
 */

const TARGET_W = 320;
const TARGET_H = 240;
const FPS_MIN = 4;
const FPS_MAX = 12;
const FPS_DEFAULT = 8;
const QUALITY_MIN = 0.30;
const QUALITY_MAX = 0.65;
const QUALITY_DEFAULT = 0.55;

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

export interface VideoWSConfig {
  ws: WebSocket;
  callId: string;
  targetUserId: string;
  /** MediaStream from getUserMedia({video:true}) — caller manages lifecycle. */
  stream: MediaStream;
  /** Called every time a frame is decoded. Caller paints it. */
  onRemoteFrame: (img: HTMLImageElement) => void;
}

export class VideoWS {
  private ws: WebSocket;
  private callId: string;
  private targetUserId: string;
  private stream: MediaStream;
  private onRemoteFrame: (img: HTMLImageElement) => void;

  private video: HTMLVideoElement | null = null;
  private canvas: HTMLCanvasElement | null = null;
  private ctx: CanvasRenderingContext2D | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  private cameraOff = false;
  private seqOut = 0;
  private decodeUrls: string[] = []; // pending object URLs to revoke

  // Adaptive quality tracking
  private currentFps = FPS_DEFAULT;
  private currentQuality = QUALITY_DEFAULT;
  private pingTs: number | null = null;
  private rttMs = 150; // initial estimate
  private pingTimer: ReturnType<typeof setInterval> | null = null;

  constructor(cfg: VideoWSConfig) {
    this.ws = cfg.ws;
    this.callId = cfg.callId;
    this.targetUserId = cfg.targetUserId;
    this.stream = cfg.stream;
    this.onRemoteFrame = cfg.onRemoteFrame;
  }

  async start(): Promise<void> {
    this.video = document.createElement('video');
    this.video.muted = true;
    this.video.playsInline = true;
    this.video.srcObject = this.stream;
    await this.video.play().catch(() => undefined);

    this.canvas = document.createElement('canvas');
    this.canvas.width = TARGET_W;
    this.canvas.height = TARGET_H;
    this.ctx = this.canvas.getContext('2d');

    this.timer = setInterval(() => this.captureAndSend(), Math.floor(1000 / this.currentFps));
    // Send RTT pings every 5s to adapt quality
    this.pingTimer = setInterval(() => this.sendPing(), 5_000);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    if (this.pingTimer) clearInterval(this.pingTimer);
    this.timer = null;
    this.pingTimer = null;
    try { this.video?.pause(); } catch { /* ignore */ }
    if (this.video) this.video.srcObject = null;
    this.video = null;
    this.canvas = null;
    this.ctx = null;
    for (const url of this.decodeUrls) {
      try { URL.revokeObjectURL(url); } catch { /* ignore */ }
    }
    this.decodeUrls = [];
  }

  setCameraOff(off: boolean): void { this.cameraOff = off; }

  handleIncomingFrame(frameB64: string): void {
    // Handle RTT pong reply
    if (frameB64.startsWith('roc-pong:') && this.pingTs !== null) {
      this.rttMs = Date.now() - this.pingTs;
      this.pingTs = null;
      this.adaptQuality();
      return;
    }
    // Respond to ping with pong
    if (frameB64.startsWith('roc-ping:')) {
      const ts = frameB64.slice(9);
      try {
        this.ws.send(JSON.stringify({
          type: 'call_video',
          payload: { callId: this.callId, targetUserId: this.targetUserId, seq: 0, frame: 'roc-pong:' + ts },
        }));
      } catch { /* ignore */ }
      return;
    }
    let bytes: Uint8Array;
    try { bytes = base64ToBytes(frameB64); } catch { return; }
    if (bytes.length < 2) return;
    const tag = bytes[0];
    if (tag !== 0x01) return; // only JPEG supported for now
    const blob = new Blob([bytes.subarray(1).slice().buffer], { type: 'image/jpeg' });
    const url = URL.createObjectURL(blob);
    const img = new Image();
    img.decoding = 'async';
    img.onload = () => {
      this.onRemoteFrame(img);
      // Keep the URL alive briefly so the consumer can paint, then free it.
      setTimeout(() => { try { URL.revokeObjectURL(url); } catch { /* ignore */ } }, 1000);
    };
    img.onerror = () => { try { URL.revokeObjectURL(url); } catch { /* ignore */ } };
    img.src = url;
  }

  private sendPing(): void {
    if (this.ws.readyState !== WebSocket.OPEN) return;
    this.pingTs = Date.now();
    try {
      this.ws.send(JSON.stringify({
        type: 'call_video',
        payload: { callId: this.callId, targetUserId: this.targetUserId, seq: 0, frame: 'roc-ping:' + this.pingTs },
      }));
    } catch { /* ignore */ }
  }

  private adaptQuality(): void {
    // Map RTT → quality tier: <80ms=high, 80-200ms=medium, >200ms=low
    if (this.rttMs < 80) {
      this.currentFps = FPS_MAX;
      this.currentQuality = QUALITY_MAX;
    } else if (this.rttMs < 200) {
      this.currentFps = FPS_DEFAULT;
      this.currentQuality = QUALITY_DEFAULT;
    } else {
      this.currentFps = FPS_MIN;
      this.currentQuality = QUALITY_MIN;
    }
    // Restart timer with new interval
    if (this.timer) { clearInterval(this.timer); }
    this.timer = setInterval(() => this.captureAndSend(), Math.floor(1000 / this.currentFps));
  }

  private captureAndSend(): void {
    if (this.cameraOff || !this.video || !this.canvas || !this.ctx) return;
    if (this.ws.readyState !== WebSocket.OPEN) return;
    if (this.video.readyState < 2 || this.video.videoWidth === 0) return;

    // Letterbox-fit so aspect ratio is preserved.
    const vw = this.video.videoWidth;
    const vh = this.video.videoHeight;
    const scale = Math.min(TARGET_W / vw, TARGET_H / vh);
    const drawW = Math.round(vw * scale);
    const drawH = Math.round(vh * scale);
    const dx = Math.floor((TARGET_W - drawW) / 2);
    const dy = Math.floor((TARGET_H - drawH) / 2);
    this.ctx.fillStyle = '#000';
    this.ctx.fillRect(0, 0, TARGET_W, TARGET_H);
    this.ctx.drawImage(this.video, dx, dy, drawW, drawH);

    this.canvas.toBlob(async (blob) => {
      if (!blob) return;
      const buf = new Uint8Array(await blob.arrayBuffer());
      const tagged = new Uint8Array(buf.length + 1);
      tagged[0] = 0x01;
      tagged.set(buf, 1);
      this.seqOut = (this.seqOut + 1) >>> 0;
      const msg = {
        type: 'call_video',
        payload: {
          callId: this.callId,
          targetUserId: this.targetUserId,
          seq: this.seqOut,
          frame: bytesToBase64(tagged),
        },
      };
      try { this.ws.send(JSON.stringify(msg)); } catch { /* socket closed */ }
    }, 'image/jpeg', this.currentQuality);
  }
}
