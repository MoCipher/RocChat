/**
 * RocChat — UserInbox Durable Object
 *
 * One instance per USER. All of a user's devices keep a long-lived WebSocket
 * here, regardless of which conversation they are currently viewing. This is
 * the routing target for **per-user** events that must reach a recipient even
 * when they have no conversation open:
 *
 *   - call_offer / call_answer / call_ice / call_end / call_p2p_candidate
 *   - call_audio / call_video frames
 *   - one-tap key transfer requests
 *
 * Chat messages, typing, presence, and read receipts continue to flow through
 * the per-conversation `ChatRoom` DO.
 *
 * Hibernation: uses `state.acceptWebSocket()` so connections survive Worker
 * sleeps. Per-socket attachment carries `{userId, deviceId}` for routing.
 */

export interface Env {
  DB: D1Database;
  KV: KVNamespace;
}

interface InboxMessage {
  type: string;
  payload: Record<string, unknown>;
}

export class UserInbox implements DurableObject {
  private state: DurableObjectState;
  private env: Env;
  // Per-user message rate window: 60 messages/sec
  private msgRateWindow: number[] = [];
  // Per-user media frame window: same caps as ChatRoom for consistency
  private mediaFrameWindow: { t: number[]; bytes: number } = { t: [], bytes: 0 };

  private static readonly MSG_RATE_PER_SEC = 60;
  private static readonly AUDIO_MAX_FRAME_B64 = 16 * 1024;
  private static readonly VIDEO_MAX_FRAME_B64 = 96 * 1024;
  private static readonly AUDIO_MAX_FPS = 75;
  private static readonly VIDEO_MAX_FPS = 16;
  private static readonly MAX_BYTES_PER_SEC = 512 * 1024;

  constructor(state: DurableObjectState, env: Env) {
    this.state = state;
    this.env = env;
  }

  // ── Hibernation helpers ──────────────────────────────────────────
  private clientFor(ws: WebSocket): { ws: WebSocket; userId: string; deviceId: string } | null {
    const att = ws.deserializeAttachment() as null | { userId: string; deviceId: string };
    if (!att) return null;
    return { ws, ...att };
  }

  private allClients(): { ws: WebSocket; userId: string; deviceId: string }[] {
    const out: { ws: WebSocket; userId: string; deviceId: string }[] = [];
    for (const ws of this.state.getWebSockets()) {
      const c = this.clientFor(ws);
      if (c) out.push(c);
    }
    return out;
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);

    // WebSocket upgrade — devices attach here for the duration of their session
    if (request.headers.get('Upgrade') === 'websocket') {
      return this.handleWebSocket(request, url);
    }

    // Internal: forward a message to all of this user's connected devices.
    // Called from ChatRoom or REST handlers when they need to route a
    // signaling event to a user who may not be on the same conversation DO.
    if (url.pathname === '/forward' && request.method === 'POST') {
      const msg = (await request.json()) as InboxMessage & { excludeDeviceId?: string };
      this.fanout(msg, msg.excludeDeviceId);
      return new Response('ok');
    }

    return new Response('Not found', { status: 404 });
  }

  private async handleWebSocket(request: Request, url: URL): Promise<Response> {
    const userId = url.searchParams.get('userId');
    const deviceId = url.searchParams.get('deviceId');
    const routerAuthed = url.searchParams.get('routerAuthed') === '1';

    if (!userId || !deviceId) {
      return new Response('Missing auth params', { status: 400 });
    }

    if (!routerAuthed) {
      const sessionToken = url.searchParams.get('token');
      if (!sessionToken) {
        return new Response('Missing auth params', { status: 400 });
      }
      const sessionData = await this.env.KV.get(`session:${sessionToken}`);
      if (!sessionData) {
        return new Response('Invalid session', { status: 401 });
      }
      const session = JSON.parse(sessionData) as { userId: string; deviceId: string };
      if (session.userId !== userId) {
        return new Response('Session mismatch', { status: 401 });
      }
    }

    const pair = new WebSocketPair();
    const [client, server] = [pair[0], pair[1]];

    const tagKey = `${userId}:${deviceId}`;
    // Replace any existing socket from this same device
    for (const existing of this.state.getWebSockets(tagKey)) {
      try { existing.close(1000, 'Replaced by new connection'); } catch { /* ok */ }
    }

    this.state.acceptWebSocket(server, [tagKey]);
    server.serializeAttachment({ userId, deviceId });

    return new Response(null, { status: 101, webSocket: client });
  }

  // ── Hibernation handlers ─────────────────────────────────────────
  async webSocketMessage(ws: WebSocket, data: string | ArrayBuffer): Promise<void> {
    const c = this.clientFor(ws);
    if (!c) return;
    let msg: InboxMessage;
    try {
      const text = typeof data === 'string' ? data : new TextDecoder().decode(data);
      msg = JSON.parse(text) as InboxMessage;
    } catch {
      return;
    }
    if (!msg || typeof msg.type !== 'string' || typeof msg.payload !== 'object' || msg.payload === null) {
      return;
    }
    await this.handleClientMessage(c, msg, ws);
  }

  async webSocketClose(_ws: WebSocket, _code: number, _reason: string, _wasClean: boolean): Promise<void> {
    // No persistent state to clean up
  }

  async webSocketError(_ws: WebSocket, _err: unknown): Promise<void> {
    // ignore
  }

  // ── Client → server routing ──────────────────────────────────────
  private async handleClientMessage(
    sender: { userId: string; deviceId: string },
    msg: InboxMessage,
    senderWs: WebSocket,
  ): Promise<void> {
    const isMediaMessage = msg.type === 'call_audio' || msg.type === 'call_video';

    // Coarse rate limit on non-media events
    if (!isMediaMessage && !this.allowMessage()) return;

    switch (msg.type) {
      case 'call_offer':
      case 'call_answer':
      case 'call_ice':
      case 'call_end':
      case 'call_p2p_candidate': {
        const targetUserId = msg.payload.targetUserId as string | undefined;
        const out = { type: msg.type, payload: { ...msg.payload, fromUserId: sender.userId } };
        if (!targetUserId) return;
        if (targetUserId === sender.userId) {
          // Multi-device echo: deliver to all of our other devices
          this.fanout(out, sender.deviceId);
          return;
        }
        // Forward to the target user's UserInbox DO
        await this.forwardToUser(targetUserId, out);
        // ALSO echo to the caller's own other devices so multi-device UIs stay in sync
        this.fanout(out, sender.deviceId);
        break;
      }

      case 'call_audio':
      case 'call_video': {
        const targetUserId = msg.payload.targetUserId as string | undefined;
        const frame = msg.payload.frame as string | undefined;
        if (!targetUserId || !frame) return;
        if (!this.allowMediaFrame(msg.type, frame.length)) {
          try { senderWs.close(4008, `${msg.type} rate limited`); } catch { /* ok */ }
          return;
        }
        const out = { type: msg.type, payload: { ...msg.payload, fromUserId: sender.userId } };
        await this.forwardToUser(targetUserId, out);
        break;
      }

      default:
        // Unknown / unsupported — ignored
        break;
    }
  }

  // ── Fan-out to local sockets (this user's devices) ──────────────
  private fanout(msg: InboxMessage, excludeDeviceId?: string): void {
    const data = JSON.stringify(msg);
    for (const c of this.allClients()) {
      if (excludeDeviceId && c.deviceId === excludeDeviceId) continue;
      try { c.ws.send(data); } catch { /* dead, ignore */ }
    }
  }

  // ── Cross-DO forward to another user's UserInbox ────────────────
  private async forwardToUser(targetUserId: string, msg: InboxMessage): Promise<void> {
    try {
      const id = (this.env as unknown as { USER_INBOX: DurableObjectNamespace }).USER_INBOX.idFromName(targetUserId);
      const stub = (this.env as unknown as { USER_INBOX: DurableObjectNamespace }).USER_INBOX.get(id);
      await stub.fetch(new Request('https://internal/forward', {
        method: 'POST',
        body: JSON.stringify(msg),
      }));
    } catch {
      // Best-effort; recipient may simply not be online
    }
  }

  // ── Rate limits ──────────────────────────────────────────────────
  private allowMessage(): boolean {
    const now = Date.now();
    while (this.msgRateWindow.length && now - this.msgRateWindow[0] > 1000) this.msgRateWindow.shift();
    if (this.msgRateWindow.length >= UserInbox.MSG_RATE_PER_SEC) return false;
    this.msgRateWindow.push(now);
    return true;
  }

  private allowMediaFrame(kind: 'call_audio' | 'call_video', b64Len: number): boolean {
    const now = Date.now();
    const win = this.mediaFrameWindow;
    while (win.t.length && now - win.t[0] > 1000) win.t.shift();
    const frameBytes = Math.floor((b64Len * 3) / 4);
    if (win.t.length === 0) win.bytes = 0;
    const maxFrame = kind === 'call_audio' ? UserInbox.AUDIO_MAX_FRAME_B64 : UserInbox.VIDEO_MAX_FRAME_B64;
    const maxFps = kind === 'call_audio' ? UserInbox.AUDIO_MAX_FPS : UserInbox.VIDEO_MAX_FPS;
    if (b64Len > maxFrame) return false;
    if (win.t.length >= maxFps) return false;
    if (win.bytes + frameBytes > UserInbox.MAX_BYTES_PER_SEC) return false;
    win.t.push(now);
    win.bytes += frameBytes;
    return true;
  }
}
