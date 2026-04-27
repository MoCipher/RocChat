/**
 * RocChat Web — User Inbox WebSocket
 *
 * A long-lived WebSocket connection to `/api/ws/user/{userId}` that all of
 * a user's devices keep open while logged in. Call signaling
 * (`call_offer`, `call_answer`, `call_ice`, `call_end`, `call_audio`,
 * `call_video`, `call_p2p_candidate`) flows over this connection so calls
 * reach the callee even if they have no conversation open.
 *
 * Per-conversation chat messages still use the existing `state.ws`
 * connection in `chat/chat.ts`; this module is purely additive.
 */

import * as api from './api.js';

type Listener = (msg: { type: string; payload: Record<string, unknown> }) => void;

let ws: WebSocket | null = null;
let isConnecting = false;
let reconnectTimer: number | null = null;
let reconnectAttempts = 0;
const listeners = new Set<Listener>();
let manuallyClosed = false;

const CALL_TYPES = new Set([
  'call_offer',
  'call_answer',
  'call_ice',
  'call_end',
  'call_audio',
  'call_video',
  'call_p2p_candidate',
]);

/**
 * Open the inbox WebSocket. Idempotent — returns the existing socket if one
 * is already open or connecting.
 */
export async function connectInbox(): Promise<WebSocket | null> {
  if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) {
    return ws;
  }
  if (isConnecting) return null;

  const token = api.getToken();
  const userId = localStorage.getItem('rocchat_user_id') || '';
  if (!token || !userId) return null;

  isConnecting = true;
  manuallyClosed = false;

  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
  const wsHost = location.host;
  const deviceId = localStorage.getItem('rocchat_device_id') || 'web';

  let url: string | null = null;
  try {
    const ticketRes = await api.getWsTicket();
    if (ticketRes.ok && ticketRes.data?.ticket) {
      url = `${proto}//${wsHost}/api/ws/user/${userId}?userId=${userId}&deviceId=${deviceId}&ticket=${ticketRes.data.ticket}`;
    }
  } catch { /* fall through */ }

  if (!url) {
    isConnecting = false;
    scheduleReconnect();
    return null;
  }

  try {
    ws = new WebSocket(url);
  } catch {
    isConnecting = false;
    scheduleReconnect();
    return null;
  }

  ws.addEventListener('open', () => {
    isConnecting = false;
    reconnectAttempts = 0;
  });

  ws.addEventListener('message', (ev) => {
    try {
      const msg = JSON.parse(typeof ev.data === 'string' ? ev.data : '');
      if (!msg || typeof msg.type !== 'string') return;
      for (const listener of listeners) {
        try { listener(msg); } catch { /* listener error — ignore */ }
      }
    } catch { /* malformed frame — ignore */ }
  });

  ws.addEventListener('close', () => {
    ws = null;
    isConnecting = false;
    if (!manuallyClosed) scheduleReconnect();
  });

  ws.addEventListener('error', () => {
    // 'close' will fire next; let it handle reconnect logic.
  });

  return ws;
}

function scheduleReconnect(): void {
  if (reconnectTimer !== null) return;
  reconnectAttempts += 1;
  // Exponential backoff capped at 30s
  const delay = Math.min(1000 * Math.pow(2, Math.min(reconnectAttempts, 5)), 30_000);
  reconnectTimer = window.setTimeout(() => {
    reconnectTimer = null;
    void connectInbox();
  }, delay);
}

export function disconnectInbox(): void {
  manuallyClosed = true;
  if (reconnectTimer !== null) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }
  if (ws && ws.readyState === WebSocket.OPEN) {
    try { ws.close(1000, 'logout'); } catch { /* ignore */ }
  }
  ws = null;
  reconnectAttempts = 0;
}

export function getInboxWs(): WebSocket | null {
  return ws && ws.readyState === WebSocket.OPEN ? ws : null;
}

/**
 * Send a message over the inbox WS. Returns true on success. Falls back to
 * `false` if the connection is not currently open — the caller should treat
 * this as a soft failure and may retry after `connectInbox()` resolves.
 */
export function sendInbox(msg: { type: string; payload: Record<string, unknown> }): boolean {
  if (!ws || ws.readyState !== WebSocket.OPEN) return false;
  try {
    ws.send(JSON.stringify(msg));
    return true;
  } catch {
    return false;
  }
}

/** Subscribe to inbox messages. Returns an unsubscribe function. */
export function onInboxMessage(listener: Listener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** True if a message type is one that flows over the inbox WS. */
export function isInboxMessageType(type: string): boolean {
  return CALL_TYPES.has(type);
}
