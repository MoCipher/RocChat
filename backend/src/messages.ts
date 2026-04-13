/**
 * RocChat Backend — Messages API
 *
 * Store and retrieve encrypted message blobs.
 * Server cannot read message content — all payloads are E2E encrypted.
 */

import type { Env } from './index.js';
import type { Session } from './middleware.js';
import { jsonResponse, errorResponse } from './middleware.js';
import { sendPushNotification } from './push.js';

export async function handleMessages(
  request: Request,
  env: Env,
  session: Session,
  url: URL,
): Promise<Response> {
  const path = url.pathname;

  // POST /api/messages/send OR /api/messages — send a message
  if ((path === '/api/messages/send' || path === '/api/messages') && request.method === 'POST') {
    return sendMessage(request, env, session);
  }

  // POST /api/messages/conversations — create a new conversation
  if ((path === '/api/messages/conversations' || path === '/api/messages/conversation') && request.method === 'POST') {
    return createConversation(request, env, session);
  }

  // GET /api/messages/conversations — list user's conversations
  if ((path === '/api/messages/conversations' || path === '/api/messages/conversations/list') && request.method === 'GET') {
    return listConversations(env, session);
  }

  // GET /api/messages/:conversationId — fetch messages
  if (request.method === 'GET') {
    const parts = path.split('/');
    const conversationId = parts[3];
    if (!conversationId) return errorResponse('Missing conversation ID', 400);
    return getMessages(env, session, conversationId, url);
  }

  return errorResponse('Not found', 404);
}

async function sendMessage(request: Request, env: Env, session: Session): Promise<Response> {
  // Limit payload size to 256KB
  const contentLength = parseInt(request.headers.get('Content-Length') || '0', 10);
  if (contentLength > 256 * 1024) {
    return errorResponse('Message payload too large', 413);
  }

  const raw = await request.json() as Record<string, unknown>;

  // Accept both flat snake_case (web/Android) and nested camelCase
  const conversationId = (raw.conversation_id ?? raw.conversationId) as string | undefined;

  // Build encrypted payload: accept flat fields or nested 'encrypted' object
  let encrypted: { header?: unknown; ciphertext?: string; iv?: string; tag?: string; ratchet_header?: string };
  if (raw.encrypted && typeof raw.encrypted === 'object') {
    encrypted = raw.encrypted as typeof encrypted;
  } else {
    // Flat format from web/Android
    const ratchetHeader = raw.ratchet_header as string | undefined;
    let header: unknown = undefined;
    if (ratchetHeader) {
      try { header = JSON.parse(ratchetHeader); } catch { header = ratchetHeader; }
    }
    encrypted = {
      header,
      ciphertext: raw.ciphertext as string,
      iv: raw.iv as string,
      tag: raw.tag as string || '',
      ratchet_header: ratchetHeader,
    };
  }

  const expiresIn = (raw.expires_in ?? raw.expiresIn) as number | undefined;
  const messageType = (raw.message_type ?? raw.messageType ?? 'text') as string;

  if (!conversationId || !encrypted.ciphertext) {
    return errorResponse('Missing conversation_id or message content', 400);
  }

  // Validate individual field sizes
  if (encrypted.ratchet_header && encrypted.ratchet_header.length > 2048) {
    return errorResponse('Ratchet header too large', 400);
  }
  if (encrypted.ciphertext.length > 256 * 1024) {
    return errorResponse('Ciphertext too large', 400);
  }
  if (encrypted.iv && encrypted.iv.length > 64) {
    return errorResponse('IV too large', 400);
  }
  if (messageType && messageType.length > 32) {
    return errorResponse('Invalid message type', 400);
  }

  // Verify membership
  const member = await env.DB.prepare(
    'SELECT 1 FROM conversation_members WHERE conversation_id = ? AND user_id = ?',
  )
    .bind(conversationId, session.userId)
    .first();

  if (!member) {
    return errorResponse('Not a member of this conversation', 403);
  }

  const messageId = crypto.randomUUID();
  const now = Math.floor(Date.now() / 1000);
  const expiresAt = expiresIn ? now + expiresIn : null;

  await env.DB.prepare(
    `INSERT INTO messages (id, conversation_id, sender_id, encrypted, server_timestamp, expires_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
  )
    .bind(
      messageId,
      conversationId,
      session.userId,
      JSON.stringify({ ...encrypted, message_type: messageType }),
      now,
      expiresAt,
    )
    .run();

  // Notify connected WebSocket clients via Durable Object
  const roomId = env.CHAT_ROOM.idFromName(conversationId);
  const room = env.CHAT_ROOM.get(roomId);
  await room.fetch(new Request('https://internal/broadcast', {
    method: 'POST',
    body: JSON.stringify({
      type: 'new_message',
      messageId,
      senderId: session.userId,
      conversationId,
      encrypted,
      messageType,
      serverTimestamp: now,
    }),
  }));

  // Send push notifications to offline members (best-effort, non-blocking)
  const otherMembers = await env.DB.prepare(
    'SELECT user_id FROM conversation_members WHERE conversation_id = ? AND user_id != ?',
  ).bind(conversationId, session.userId).all<{ user_id: string }>();

  if (otherMembers.results?.length) {
    const sender = await env.DB.prepare('SELECT display_name FROM users WHERE id = ?')
      .bind(session.userId).first<{ display_name: string }>();
    const senderName = sender?.display_name || 'Someone';

    // Fire-and-forget push to all other members
    for (const m of otherMembers.results) {
      sendPushNotification(env, m.user_id, senderName).catch(() => {});
    }
  }

  return jsonResponse({ message_id: messageId, server_timestamp: now }, 201);
}

async function getMessages(
  env: Env,
  session: Session,
  conversationId: string,
  url: URL,
): Promise<Response> {
  // Verify membership
  const member = await env.DB.prepare(
    'SELECT 1 FROM conversation_members WHERE conversation_id = ? AND user_id = ?',
  )
    .bind(conversationId, session.userId)
    .first();

  if (!member) {
    return errorResponse('Not a member of this conversation', 403);
  }

  const beforeRaw = url.searchParams.get('before'); // cursor: server_timestamp
  const before = beforeRaw ? parseInt(beforeRaw, 10) : null;
  if (beforeRaw && (before === null || isNaN(before))) {
    return errorResponse('Invalid cursor', 400);
  }
  const limit = Math.min(parseInt(url.searchParams.get('limit') || '50', 10), 100);

  let query: string;
  let params: unknown[];

  if (before !== null) {
    query = `SELECT id, sender_id, encrypted, server_timestamp, expires_at
             FROM messages WHERE conversation_id = ? AND server_timestamp < ?
             ORDER BY server_timestamp DESC LIMIT ?`;
    params = [conversationId, before, limit];
  } else {
    query = `SELECT id, sender_id, encrypted, server_timestamp, expires_at
             FROM messages WHERE conversation_id = ?
             ORDER BY server_timestamp DESC LIMIT ?`;
    params = [conversationId, limit];
  }

  const result = await env.DB.prepare(query).bind(...params).all();

  const messages = result.results.map((row: Record<string, unknown>) => {
    let parsed: Record<string, unknown> = {};
    try { parsed = JSON.parse(row.encrypted as string); } catch { /* ok */ }

    return {
      id: row.id,
      conversation_id: conversationId,
      sender_id: row.sender_id,
      ciphertext: parsed.ciphertext || '',
      iv: parsed.iv || '',
      ratchet_header: parsed.ratchet_header || (parsed.header ? JSON.stringify(parsed.header) : ''),
      message_type: parsed.message_type || 'text',
      created_at: new Date((row.server_timestamp as number) * 1000).toISOString(),
      expires_at: row.expires_at,
    };
  });

  return jsonResponse({ messages });
}

async function createConversation(
  request: Request,
  env: Env,
  session: Session,
): Promise<Response> {
  const raw = await request.json() as Record<string, unknown>;

  const type = raw.type as 'direct' | 'group' | undefined;
  const memberIds = (raw.member_ids ?? raw.memberIds) as string[] | undefined;
  const name = raw.name as string | undefined;
  const encryptedMeta = (raw.encrypted_meta ?? raw.encryptedMeta) as string | undefined;

  if (!type || !memberIds?.length) {
    return errorResponse('Missing type or member_ids', 400);
  }

  if (type === 'direct' && memberIds.length !== 1) {
    return errorResponse('Direct conversation must have exactly one other member', 400);
  }

  // For direct: check if conversation already exists
  if (type === 'direct') {
    const otherUserId = memberIds[0];
    const existing = await env.DB.prepare(
      `SELECT c.id FROM conversations c
       JOIN conversation_members cm1 ON cm1.conversation_id = c.id AND cm1.user_id = ?
       JOIN conversation_members cm2 ON cm2.conversation_id = c.id AND cm2.user_id = ?
       WHERE c.type = 'direct'`,
    )
      .bind(session.userId, otherUserId)
      .first<{ id: string }>();

    if (existing) {
      return jsonResponse({ conversation_id: existing.id, existing: true });
    }
  }

  const conversationId = crypto.randomUUID();
  const now = Math.floor(Date.now() / 1000);
  const allMembers = [session.userId, ...memberIds];

  const statements = [
    env.DB.prepare(
      `INSERT INTO conversations (id, type, encrypted_meta, created_at) VALUES (?, ?, ?, ?)`,
    ).bind(conversationId, type, encryptedMeta || name || null, now),

    ...allMembers.map((memberId, i) =>
      env.DB.prepare(
        `INSERT INTO conversation_members (conversation_id, user_id, role, joined_at) VALUES (?, ?, ?, ?)`,
      ).bind(conversationId, memberId, i === 0 ? 'admin' : 'member', now),
    ),
  ];

  await env.DB.batch(statements);

  return jsonResponse({ conversation_id: conversationId }, 201);
}

async function listConversations(env: Env, session: Session): Promise<Response> {
  const result = await env.DB.prepare(
    `SELECT c.id, c.type, c.encrypted_meta, c.created_at,
            (SELECT json_group_array(json_object(
              'user_id', cm2.user_id,
              'username', u2.username,
              'display_name', COALESCE(u2.display_name, u2.username),
              'role', cm2.role
            ))
             FROM conversation_members cm2
             JOIN users u2 ON u2.id = cm2.user_id
             WHERE cm2.conversation_id = c.id) as members,
            (SELECT MAX(m.server_timestamp) FROM messages m WHERE m.conversation_id = c.id) as last_message_at
     FROM conversations c
     JOIN conversation_members cm ON cm.conversation_id = c.id AND cm.user_id = ?
     ORDER BY last_message_at DESC NULLS LAST`,
  )
    .bind(session.userId)
    .all();

  const conversations = result.results.map((row: Record<string, unknown>) => ({
    id: row.id,
    type: row.type,
    name: row.encrypted_meta,
    members: JSON.parse(row.members as string || '[]'),
    last_message_at: row.last_message_at
      ? new Date((row.last_message_at as number) * 1000).toISOString()
      : null,
  }));

  return jsonResponse({ conversations });
}
