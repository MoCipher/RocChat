/**
 * RocChat — ChatRoom Durable Object
 *
 * One instance per conversation. Manages WebSocket connections for:
 * - Real-time encrypted message relay
 * - Typing indicators
 * - Presence (online/offline)
 * - WebRTC call signaling (offer, answer, ICE candidates, end)
 */

export interface Env {
  DB: D1Database;
  KV: KVNamespace;
}

interface ConnectedClient {
  ws: WebSocket;
  userId: string;
  deviceId: string;
  token: string;
  lastAuthCheck: number;
}

interface WsMessage {
  type:
    | 'message'
    | 'typing'
    | 'presence'
    | 'call_offer'
    | 'call_answer'
    | 'call_ice'
    | 'call_end'
    | 'call_audio'
    | 'call_p2p_candidate'
    | 'read_receipt'
    | 'delivery_receipt'
    | 'group_call_start'
    | 'group_call_join'
    | 'group_call_leave'
    | 'group_call_offer'
    | 'group_call_answer'
    | 'group_call_ice'
    | 'reaction'
    | 'message_edit'
    | 'message_delete'
    | 'message_pin';
  payload: Record<string, unknown>;
}

export class ChatRoom implements DurableObject {
  private clients: Map<string, ConnectedClient> = new Map();
  private state: DurableObjectState;
  private env: Env;

  constructor(state: DurableObjectState, env: Env) {
    this.state = state;
    this.env = env;
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);

    // WebSocket upgrade
    if (request.headers.get('Upgrade') === 'websocket') {
      return this.handleWebSocket(request, url);
    }

    // Internal broadcast from REST API (e.g., sendMessage calls this)
    if (url.pathname === '/broadcast' && request.method === 'POST') {
      const body = (await request.json()) as WsMessage & { excludeUserId?: string };
      this.broadcast(body, body.excludeUserId);
      return new Response('ok');
    }

    return new Response('Not found', { status: 404 });
  }

  private async handleWebSocket(request: Request, url: URL): Promise<Response> {
    const userId = url.searchParams.get('userId');
    const deviceId = url.searchParams.get('deviceId');
    const sessionToken = url.searchParams.get('token');

    if (!userId || !deviceId || !sessionToken) {
      return new Response('Missing auth params', { status: 400 });
    }

    // Verify session token via KV (userId only — deviceId varies by platform)
    const sessionData = await this.env.KV.get(`session:${sessionToken}`);
    if (!sessionData) {
      return new Response('Invalid session', { status: 401 });
    }

    const session = JSON.parse(sessionData) as { userId: string; deviceId: string };
    if (session.userId !== userId) {
      return new Response('Session mismatch', { status: 401 });
    }

    const pair = new WebSocketPair();
    const [client, server] = [pair[0], pair[1]];

    const clientKey = `${userId}:${deviceId}`;

    // Close existing connection from same device
    const existing = this.clients.get(clientKey);
    if (existing) {
      try { existing.ws.close(1000, 'Replaced by new connection'); } catch {}
    }

    this.state.acceptWebSocket(server);
    this.clients.set(clientKey, {
      ws: server, userId, deviceId,
      token: sessionToken,
      lastAuthCheck: Date.now(),
    });

    // Notify others that user is online
    this.broadcast(
      { type: 'presence', payload: { userId, status: 'online' } },
      userId,
    );

    server.addEventListener('message', (event) => {
      void this.handleMessage(clientKey, event.data);
    });

    server.addEventListener('close', () => {
      this.clients.delete(clientKey);
      this.broadcast(
        { type: 'presence', payload: { userId, status: 'offline' } },
        userId,
      );
      // Persist last_seen
      try {
        this.env.DB.prepare(
          `UPDATE users SET last_seen_at = datetime('now') WHERE id = ?`
        ).bind(userId).run();
      } catch { /* column may not exist yet */ }
    });

    server.addEventListener('error', () => {
      this.clients.delete(clientKey);
    });

    return new Response(null, { status: 101, webSocket: client });
  }

  private async handleMessage(senderKey: string, data: string | ArrayBuffer): Promise<void> {
    if (typeof data !== 'string') return;

    let msg: WsMessage;
    try {
      msg = JSON.parse(data);
    } catch {
      return; // Ignore malformed
    }

    const sender = this.clients.get(senderKey);
    if (!sender) return;

    // Re-validate session every 60 seconds to catch revoked/expired tokens
    const SESSION_RECHECK_MS = 60_000;
    if (Date.now() - sender.lastAuthCheck > SESSION_RECHECK_MS) {
      const sessionData = await this.env.KV.get(`session:${sender.token}`);
      if (!sessionData) {
        try { sender.ws.close(4001, 'Session expired'); } catch {}
        this.clients.delete(senderKey);
        return;
      }
      try {
        const sess = JSON.parse(sessionData) as { userId: string; expiresAt: number };
        if (sess.userId !== sender.userId || sess.expiresAt < Math.floor(Date.now() / 1000)) {
          try { sender.ws.close(4001, 'Session expired'); } catch {}
          this.clients.delete(senderKey);
          return;
        }
      } catch {
        try { sender.ws.close(4001, 'Session invalid'); } catch {}
        this.clients.delete(senderKey);
        return;
      }
      sender.lastAuthCheck = Date.now();
    }

    switch (msg.type) {
      case 'typing':
        // Relay typing indicator to all other members
        this.broadcast(
          {
            type: 'typing',
            payload: { userId: sender.userId, ...msg.payload },
          },
          sender.userId,
        );
        break;

      case 'call_offer':
      case 'call_answer':
      case 'call_ice':
      case 'call_end': {
        // Relay call signaling — enforce sender identity
        const targetUserId = msg.payload.targetUserId as string | undefined;
        const signalPayload = { ...msg.payload, fromUserId: sender.userId };
        if (targetUserId) {
          this.sendToUser(targetUserId, {
            type: msg.type,
            payload: signalPayload,
          });
        } else {
          this.broadcast(
            {
              type: msg.type,
              payload: signalPayload,
            },
            sender.userId,
          );
        }
        break;
      }

      case 'call_audio': {
        // Relay encrypted audio frames — zero-knowledge, server only forwards
        // Payload: { callId, targetUserId, seq, frame (base64 opus/pcm) }
        const targetUserId = msg.payload.targetUserId as string | undefined;
        if (!targetUserId) break;
        this.sendToUser(targetUserId, {
          type: 'call_audio',
          payload: { ...msg.payload, fromUserId: sender.userId },
        });
        break;
      }

      case 'call_p2p_candidate': {
        // Relay a RocP2P UDP candidate (host or srflx) so the peer can hole-punch
        const targetUserId = msg.payload.targetUserId as string | undefined;
        if (!targetUserId) break;
        this.sendToUser(targetUserId, {
          type: 'call_p2p_candidate',
          payload: { ...msg.payload, fromUserId: sender.userId },
        });
        break;
      }

      // Group call signaling — broadcast start/join/leave, targeted offer/answer/ice
      case 'group_call_start':
      case 'group_call_join':
      case 'group_call_leave':
        this.broadcast(
          { type: msg.type, payload: { ...msg.payload, fromUserId: sender.userId } },
          sender.userId,
        );
        break;

      case 'group_call_offer':
      case 'group_call_answer':
      case 'group_call_ice': {
        const gcTarget = msg.payload.targetUserId as string | undefined;
        const gcPayload = { ...msg.payload, fromUserId: sender.userId };
        if (gcTarget) {
          this.sendToUser(gcTarget, { type: msg.type, payload: gcPayload });
        } else {
          this.broadcast({ type: msg.type, payload: gcPayload }, sender.userId);
        }
        break;
      }

      case 'read_receipt': {
        const messageId = msg.payload.message_id as string | undefined;
        this.broadcast(
          {
            type: 'read_receipt',
            payload: { userId: sender.userId, ...msg.payload },
          },
          sender.userId,
        );
        // Persist to D1
        if (messageId) {
          try {
            await this.env.DB.prepare(
              `INSERT INTO message_receipts (message_id, user_id, status) VALUES (?, ?, 'read')
               ON CONFLICT(message_id, user_id) DO UPDATE SET status = 'read', created_at = datetime('now')`
            ).bind(messageId, sender.userId).run();
          } catch { /* table may not exist yet */ }
          // Burn-on-read: delete view_once messages after recipient reads them
          try {
            await this.env.DB.prepare(
              `DELETE FROM messages WHERE id = ? AND message_type = 'view_once'`
            ).bind(messageId).run();
          } catch { /* ignore */ }
          // Burn-on-read conversation setting: delete any message when burn_on_read is enabled
          try {
            const bor = await this.env.DB.prepare(
              `SELECT cm.burn_on_read FROM conversation_meta cm
               JOIN messages m ON m.conversation_id = cm.conversation_id
               WHERE m.id = ? AND cm.burn_on_read = 1`
            ).bind(messageId).first<{ burn_on_read: number }>();
            if (bor) {
              await this.env.DB.prepare(`DELETE FROM messages WHERE id = ?`).bind(messageId).run();
              this.broadcast({ type: 'message_deleted', payload: { message_id: messageId } }, sender.userId);
            }
          } catch { /* ignore */ }
        }
        break;
      }

      case 'delivery_receipt': {
        const delivMsgId = msg.payload.message_id as string | undefined;
        this.broadcast(
          {
            type: 'delivery_receipt',
            payload: { userId: sender.userId, ...msg.payload },
          },
          sender.userId,
        );
        if (delivMsgId) {
          try {
            await this.env.DB.prepare(
              `INSERT INTO message_receipts (message_id, user_id, status) VALUES (?, ?, 'delivered')
               ON CONFLICT(message_id, user_id) DO NOTHING`
            ).bind(delivMsgId, sender.userId).run();
          } catch { /* table may not exist yet */ }
        }
        break;
      }

      case 'message':
        // Encrypted message relay — server never decrypts
        // Enforce sender identity — prevent spoofing
        this.broadcast(
          {
            type: 'message',
            payload: { ...msg.payload, fromUserId: sender.userId },
          },
          sender.userId,
        );
        break;

      case 'reaction':
        this.broadcast(
          {
            type: 'reaction',
            payload: { ...msg.payload, fromUserId: sender.userId },
          },
          sender.userId,
        );
        break;

      case 'message_edit':
        this.broadcast(
          {
            type: 'message_edit',
            payload: { ...msg.payload, fromUserId: sender.userId },
          },
          sender.userId,
        );
        break;

      case 'message_delete':
        this.broadcast(
          {
            type: 'message_delete',
            payload: { ...msg.payload, fromUserId: sender.userId },
          },
          sender.userId,
        );
        break;

      case 'message_pin':
        this.broadcast(
          {
            type: 'message_pin',
            payload: { ...msg.payload, fromUserId: sender.userId },
          },
          sender.userId,
        );
        break;

      default:
        // Unknown message type — ignore silently
        break;
    }
  }

  private broadcast(msg: WsMessage & { excludeUserId?: string }, excludeUserId?: string): void {
    const data = JSON.stringify(msg);
    for (const [, client] of this.clients) {
      if (excludeUserId && client.userId === excludeUserId) continue;
      try {
        client.ws.send(data);
      } catch {
        // Connection dead, will be cleaned up on close event
      }
    }
  }

  private sendToUser(userId: string, msg: WsMessage): void {
    const data = JSON.stringify(msg);
    for (const [, client] of this.clients) {
      if (client.userId === userId) {
        try {
          client.ws.send(data);
        } catch {}
      }
    }
  }
}
