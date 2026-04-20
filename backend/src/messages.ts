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
    const includeArchived = url.searchParams.get('include_archived') === '1';
    return listConversations(env, session, includeArchived);
  }

  // DELETE /api/messages/conversations/:id — leave/delete a conversation
  if (request.method === 'DELETE') {
    const parts = path.split('/');
    if (parts[3] === 'conversations' && parts[4]) {
      const convId = parts[4];
      // Remove the user's membership
      await env.DB.prepare('DELETE FROM conversation_members WHERE conversation_id = ? AND user_id = ?')
        .bind(convId, session.userId).run();
      return jsonResponse({ ok: true });
    }
  }

  // POST /api/messages/conversations/:id/mute — toggle mute
  if (request.method === 'POST' && path.match(/^\/api\/messages\/conversations\/[^/]+\/mute$/)) {
    const convId = path.split('/')[4];
    const member = await env.DB.prepare(
      'SELECT muted_at FROM conversation_members WHERE conversation_id = ? AND user_id = ?'
    ).bind(convId, session.userId).first<{ muted_at: number | null }>();
    if (!member) return errorResponse('Not a member', 403);
    const newMuted = member.muted_at ? null : Math.floor(Date.now() / 1000);
    await env.DB.prepare(
      'UPDATE conversation_members SET muted_at = ? WHERE conversation_id = ? AND user_id = ?'
    ).bind(newMuted, convId, session.userId).run();
    return jsonResponse({ muted: !!newMuted });
  }

  // POST /api/messages/conversations/:id/notification-mode — set notification mode
  if (request.method === 'POST' && path.match(/^\/api\/messages\/conversations\/[^/]+\/notification-mode$/)) {
    const convId = path.split('/')[4];
    const body = await request.json() as { mode: string };
    const validModes = ['normal', 'quiet', 'focus', 'emergency', 'silent', 'scheduled'];
    if (!validModes.includes(body.mode)) return errorResponse('Invalid notification mode', 400);
    await env.DB.prepare(
      'UPDATE conversation_members SET notification_mode = ? WHERE conversation_id = ? AND user_id = ?'
    ).bind(body.mode, convId, session.userId).run();
    return jsonResponse({ notification_mode: body.mode });
  }

  // POST /api/messages/conversations/:id/archive — toggle archive
  if (request.method === 'POST' && path.match(/^\/api\/messages\/conversations\/[^/]+\/archive$/)) {
    const convId = path.split('/')[4];
    const member = await env.DB.prepare(
      'SELECT archived_at FROM conversation_members WHERE conversation_id = ? AND user_id = ?'
    ).bind(convId, session.userId).first<{ archived_at: number | null }>();
    if (!member) return errorResponse('Not a member', 403);
    const newArchived = member.archived_at ? null : Math.floor(Date.now() / 1000);
    await env.DB.prepare(
      'UPDATE conversation_members SET archived_at = ? WHERE conversation_id = ? AND user_id = ?'
    ).bind(newArchived, convId, session.userId).run();
    return jsonResponse({ archived: !!newArchived });
  }

  // PUT /api/messages/conversations/:id/theme — set per-conversation chat theme
  if (request.method === 'PUT' && path.match(/^\/api\/messages\/conversations\/[^/]+\/theme$/)) {
    const convId = path.split('/')[4];
    const body = await request.json() as { theme: string | null };
    const validThemes = [null, 'default', 'midnight-blue', 'forest-green', 'sunset-amber', 'ocean-teal', 'rose-gold', 'lavender', 'charcoal'];
    if (!validThemes.includes(body.theme)) return errorResponse('Invalid theme', 400);
    await env.DB.prepare(
      'UPDATE conversation_members SET chat_theme = ? WHERE conversation_id = ? AND user_id = ?'
    ).bind(body.theme, convId, session.userId).run();
    return jsonResponse({ chat_theme: body.theme });
  }

  // PUT /api/messages/conversations/:id/disappearing — set per-conversation disappearing timers
  if (request.method === 'PUT' && path.match(/^\/api\/messages\/conversations\/[^/]+\/disappearing$/)) {
    const convId = path.split('/')[4];
    const body = await request.json() as {
      media_expiry?: number | null;
      voice_expiry?: number | null;
      call_history_expiry?: number | null;
      burn_on_read?: boolean;
    };
    const updates: string[] = [];
    const values: (number | null)[] = [];
    if ('media_expiry' in body) { updates.push('media_expiry = ?'); values.push(body.media_expiry ?? null); }
    if ('voice_expiry' in body) { updates.push('voice_expiry = ?'); values.push(body.voice_expiry ?? null); }
    if ('call_history_expiry' in body) { updates.push('call_history_expiry = ?'); values.push(body.call_history_expiry ?? null); }
    if ('burn_on_read' in body) { updates.push('burn_on_read = ?'); values.push(body.burn_on_read ? 1 : 0); }
    if (updates.length === 0) return errorResponse('No fields to update', 400);
    await env.DB.prepare(
      `UPDATE conversation_members SET ${updates.join(', ')} WHERE conversation_id = ? AND user_id = ?`
    ).bind(...values, convId, session.userId).run();
    return jsonResponse({ ok: true });
  }

  // POST /api/messages/conversations/:id/pin — toggle pin conversation
  if (request.method === 'POST' && path.match(/^\/api\/messages\/conversations\/[^/]+\/pin$/)) {
    const convId = path.split('/')[4];
    const member = await env.DB.prepare(
      'SELECT pinned_at FROM conversation_members WHERE conversation_id = ? AND user_id = ?'
    ).bind(convId, session.userId).first<{ pinned_at: number | null }>();
    if (!member) return errorResponse('Not a member', 403);
    const newPinned = member.pinned_at ? null : Math.floor(Date.now() / 1000);
    await env.DB.prepare(
      'UPDATE conversation_members SET pinned_at = ? WHERE conversation_id = ? AND user_id = ?'
    ).bind(newPinned, convId, session.userId).run();
    return jsonResponse({ pinned: !!newPinned });
  }

  // ── Message Reactions ──

  // POST /api/messages/:msgId/react — add/update reaction
  if (request.method === 'POST' && path.match(/^\/api\/messages\/[^/]+\/react$/)) {
    const msgId = path.split('/')[3];
    const body = await request.json() as { encrypted_reaction: string };
    if (!body.encrypted_reaction) return errorResponse('Missing encrypted_reaction', 400);
    // Verify message exists and user is member of conversation
    const msg = await env.DB.prepare('SELECT conversation_id FROM messages WHERE id = ?').bind(msgId).first<{ conversation_id: string }>();
    if (!msg) return errorResponse('Message not found', 404);
    const member = await env.DB.prepare('SELECT 1 FROM conversation_members WHERE conversation_id = ? AND user_id = ?')
      .bind(msg.conversation_id, session.userId).first();
    if (!member) return errorResponse('Not a member', 403);
    const id = crypto.randomUUID();
    await env.DB.prepare(
      'INSERT INTO message_reactions (id, message_id, user_id, encrypted_reaction) VALUES (?, ?, ?, ?) ON CONFLICT(message_id, user_id) DO UPDATE SET encrypted_reaction = excluded.encrypted_reaction, created_at = unixepoch()'
    ).bind(id, msgId, session.userId, body.encrypted_reaction).run();
    // Broadcast reaction via Durable Object
    const roomId = env.CHAT_ROOM.idFromName(msg.conversation_id);
    const room = env.CHAT_ROOM.get(roomId);
    await room.fetch(new Request('https://internal/broadcast', {
      method: 'POST',
      body: JSON.stringify({ type: 'reaction', payload: { message_id: msgId, user_id: session.userId, encrypted_reaction: body.encrypted_reaction } }),
    }));
    return jsonResponse({ ok: true, id });
  }

  // DELETE /api/messages/:msgId/react — remove reaction
  if (request.method === 'DELETE' && path.match(/^\/api\/messages\/[^/]+\/react$/)) {
    const msgId = path.split('/')[3];
    const msg = await env.DB.prepare('SELECT conversation_id FROM messages WHERE id = ?').bind(msgId).first<{ conversation_id: string }>();
    if (!msg) return errorResponse('Message not found', 404);
    const member = await env.DB.prepare('SELECT 1 FROM conversation_members WHERE conversation_id = ? AND user_id = ?').bind(msg.conversation_id, session.userId).first();
    if (!member) return errorResponse('Not a member', 403);
    await env.DB.prepare('DELETE FROM message_reactions WHERE message_id = ? AND user_id = ?')
      .bind(msgId, session.userId).run();
    return jsonResponse({ ok: true });
  }

  // GET /api/messages/:msgId/reactions — get reactions for a message
  if (request.method === 'GET' && path.match(/^\/api\/messages\/[^/]+\/reactions$/)) {
    const msgId = path.split('/')[3];
    const msg = await env.DB.prepare('SELECT conversation_id FROM messages WHERE id = ?').bind(msgId).first<{ conversation_id: string }>();
    if (!msg) return errorResponse('Message not found', 404);
    const member = await env.DB.prepare('SELECT 1 FROM conversation_members WHERE conversation_id = ? AND user_id = ?').bind(msg.conversation_id, session.userId).first();
    if (!member) return errorResponse('Not a member', 403);
    const reactions = await env.DB.prepare(
      'SELECT id, user_id, encrypted_reaction, created_at FROM message_reactions WHERE message_id = ? ORDER BY created_at'
    ).bind(msgId).all();
    return jsonResponse(reactions.results);
  }

  // ── Message Edit ──

  // PATCH /api/messages/:msgId — edit message (re-encrypt)
  if (request.method === 'PATCH' && path.match(/^\/api\/messages\/[^/]+$/) && !path.includes('conversations')) {
    const msgId = path.split('/')[3];
    const body = await request.json() as { encrypted: string };
    if (!body.encrypted) return errorResponse('Missing encrypted payload', 400);
    // Only sender can edit
    const msg = await env.DB.prepare('SELECT sender_id, conversation_id FROM messages WHERE id = ? AND deleted_at IS NULL')
      .bind(msgId).first<{ sender_id: string; conversation_id: string }>();
    if (!msg) return errorResponse('Message not found', 404);
    if (msg.sender_id !== session.userId) return errorResponse('Not your message', 403);
    await env.DB.prepare('UPDATE messages SET encrypted = ?, edited_at = unixepoch() WHERE id = ?')
      .bind(body.encrypted, msgId).run();
    // Broadcast edit via Durable Object
    const roomId = env.CHAT_ROOM.idFromName(msg.conversation_id);
    const room = env.CHAT_ROOM.get(roomId);
    await room.fetch(new Request('https://internal/broadcast', {
      method: 'POST',
      body: JSON.stringify({ type: 'message_edit', payload: { message_id: msgId, encrypted: body.encrypted, edited_at: Math.floor(Date.now() / 1000) } }),
    }));
    return jsonResponse({ ok: true });
  }

  // ── Message Delete ──

  // DELETE /api/messages/:msgId — soft-delete message
  if (request.method === 'DELETE' && path.match(/^\/api\/messages\/[^/]+$/) && !path.includes('conversations')) {
    const msgId = path.split('/')[3];
    const msg = await env.DB.prepare('SELECT sender_id, conversation_id FROM messages WHERE id = ? AND deleted_at IS NULL')
      .bind(msgId).first<{ sender_id: string; conversation_id: string }>();
    if (!msg) return errorResponse('Message not found', 404);
    if (msg.sender_id !== session.userId) return errorResponse('Not your message', 403);
    await env.DB.prepare('UPDATE messages SET deleted_at = unixepoch(), encrypted = ? WHERE id = ?')
      .bind('{}', msgId).run();
    // Broadcast delete
    const roomId = env.CHAT_ROOM.idFromName(msg.conversation_id);
    const room = env.CHAT_ROOM.get(roomId);
    await room.fetch(new Request('https://internal/broadcast', {
      method: 'POST',
      body: JSON.stringify({ type: 'message_delete', payload: { message_id: msgId } }),
    }));
    return jsonResponse({ ok: true });
  }

  // ── Pinned Messages ──

  // POST /api/messages/conversations/:id/pin/:msgId — pin a message
  if (request.method === 'POST' && path.match(/^\/api\/messages\/conversations\/[^/]+\/pin\/[^/]+$/)) {
    const parts = path.split('/');
    const convId = parts[4];
    const msgId = parts[6];
    const member = await env.DB.prepare('SELECT 1 FROM conversation_members WHERE conversation_id = ? AND user_id = ?')
      .bind(convId, session.userId).first();
    if (!member) return errorResponse('Not a member', 403);
    await env.DB.prepare(
      'INSERT INTO pinned_messages (conversation_id, message_id, pinned_by) VALUES (?, ?, ?) ON CONFLICT DO NOTHING'
    ).bind(convId, msgId, session.userId).run();
    // Broadcast pin
    const roomId = env.CHAT_ROOM.idFromName(convId);
    const room = env.CHAT_ROOM.get(roomId);
    await room.fetch(new Request('https://internal/broadcast', {
      method: 'POST',
      body: JSON.stringify({ type: 'message_pin', payload: { message_id: msgId, pinned_by: session.userId } }),
    }));
    return jsonResponse({ ok: true });
  }

  // DELETE /api/messages/conversations/:id/pin/:msgId — unpin
  if (request.method === 'DELETE' && path.match(/^\/api\/messages\/conversations\/[^/]+\/pin\/[^/]+$/)) {
    const parts = path.split('/');
    const convId = parts[4];
    const msgId = parts[6];
    const member = await env.DB.prepare('SELECT 1 FROM conversation_members WHERE conversation_id = ? AND user_id = ?').bind(convId, session.userId).first();
    if (!member) return errorResponse('Not a member', 403);
    await env.DB.prepare('DELETE FROM pinned_messages WHERE conversation_id = ? AND message_id = ?')
      .bind(convId, msgId).run();
    return jsonResponse({ ok: true });
  }

  // GET /api/messages/conversations/:id/pins — list pinned messages
  if (request.method === 'GET' && path.match(/^\/api\/messages\/conversations\/[^/]+\/pins$/)) {
    const convId = path.split('/')[4];
    const pins = await env.DB.prepare(
      'SELECT pm.message_id, pm.pinned_by, pm.pinned_at, m.encrypted, m.sender_id, m.server_timestamp FROM pinned_messages pm JOIN messages m ON pm.message_id = m.id WHERE pm.conversation_id = ? ORDER BY pm.pinned_at DESC'
    ).bind(convId).all();
    return jsonResponse(pins.results);
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
  // Hard cap: 10 MB total ciphertext payload.
  const MAX_PAYLOAD = 10 * 1024 * 1024;
  const contentLength = parseInt(request.headers.get('Content-Length') || '0', 10);
  if (contentLength > MAX_PAYLOAD) {
    return errorResponse('Message payload too large (max 10MB)', 413);
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
  const replyTo = (raw.reply_to ?? raw.replyTo) as string | undefined;
  const priority = (['normal', 'high', 'urgent'].includes(raw.priority as string) ? raw.priority : 'normal') as string;

  if (!conversationId || !encrypted.ciphertext) {
    return errorResponse('Missing conversation_id or message content', 400);
  }

  // Validate individual field sizes
  if (encrypted.ratchet_header && encrypted.ratchet_header.length > 2048) {
    return errorResponse('Ratchet header too large', 400);
  }
  if (encrypted.ciphertext.length > 10 * 1024 * 1024) {
    return errorResponse('Ciphertext too large', 413);
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

  // Mute enforcement — a group moderator may have silenced this user via
  // /api/groups/:id/mute. If the muted_until column does not exist yet we
  // treat it as "not muted" (the groups handler adds it lazily on first use).
  try {
    const row = await env.DB.prepare(
      'SELECT muted_until FROM conversation_members WHERE conversation_id = ? AND user_id = ?'
    ).bind(conversationId, session.userId).first<{ muted_until: number | null }>();
    if (row && row.muted_until && row.muted_until > Math.floor(Date.now() / 1000)) {
      return errorResponse('You are muted in this conversation', 403);
    }
  } catch { /* column missing — treat as not muted */ }

  const messageId = crypto.randomUUID();
  const now = Math.floor(Date.now() / 1000);
  const expiresAt = expiresIn ? now + expiresIn : null;

  // Per-user storage quota (10,000 stored messages max)
  const countRow = await env.DB.prepare(
    'SELECT COUNT(*) as cnt FROM messages WHERE sender_id = ?'
  ).bind(session.userId).first<{ cnt: number }>();
  if (countRow && countRow.cnt >= 10_000) {
    return errorResponse('Storage quota exceeded — delete old messages first', 413);
  }

  await env.DB.prepare(
    `INSERT INTO messages (id, conversation_id, sender_id, encrypted, server_timestamp, expires_at, reply_to, priority)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  )
    .bind(
      messageId,
      conversationId,
      session.userId,
      JSON.stringify({ ...encrypted, message_type: messageType }),
      now,
      expiresAt,
      replyTo || null,
      priority,
    )
    .run();

  // Notify connected WebSocket clients via Durable Object
  const roomId = env.CHAT_ROOM.idFromName(conversationId);
  const room = env.CHAT_ROOM.get(roomId);
  await room.fetch(new Request('https://internal/broadcast', {
    method: 'POST',
    body: JSON.stringify({
      type: 'message',
      payload: {
        id: messageId,
        fromUserId: session.userId,
        ciphertext: encrypted.ciphertext || '',
        iv: encrypted.iv || '',
        ratchet_header: encrypted.ratchet_header || (encrypted.header ? JSON.stringify(encrypted.header) : ''),
        tag: encrypted.tag || '',
        message_type: messageType,
        priority,
        created_at: new Date(now * 1000).toISOString(),
      },
      excludeUserId: session.userId,
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
      sendPushNotification(env, m.user_id, senderName, session.userId, priority).catch(() => {});
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
    query = `SELECT id, sender_id, encrypted, server_timestamp, expires_at, reply_to, edited_at, deleted_at
             FROM messages WHERE conversation_id = ? AND server_timestamp < ?
             ORDER BY server_timestamp DESC LIMIT ?`;
    params = [conversationId, before, limit];
  } else {
    query = `SELECT id, sender_id, encrypted, server_timestamp, expires_at, reply_to, edited_at, deleted_at
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
      tag: parsed.tag || '',
      ratchet_header: parsed.ratchet_header || (parsed.header ? JSON.stringify(parsed.header) : ''),
      message_type: parsed.message_type || 'text',
      created_at: new Date((row.server_timestamp as number) * 1000).toISOString(),
      expires_at: row.expires_at,
      reply_to: row.reply_to || null,
      edited_at: row.edited_at || null,
      deleted_at: row.deleted_at || null,
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

async function listConversations(env: Env, session: Session, includeArchived: boolean = false): Promise<Response> {
  const archivedFilter = includeArchived ? '' : 'AND cm.archived_at IS NULL';
  const result = await env.DB.prepare(
    `SELECT c.id, c.type, c.encrypted_meta, c.created_at,
            cm.muted_at, cm.archived_at, cm.chat_theme, cm.pinned_at,
            cm.media_expiry, cm.voice_expiry, cm.call_history_expiry, cm.burn_on_read,
            (SELECT json_group_array(json_object(
              'user_id', cm2.user_id,
              'username', u2.username,
              'display_name', COALESCE(u2.display_name, u2.username),
              'role', cm2.role,
              'avatar_url', u2.avatar_url,
              'account_tier', u2.account_tier
            ))
             FROM conversation_members cm2
             JOIN users u2 ON u2.id = cm2.user_id
             WHERE cm2.conversation_id = c.id) as members,
            (SELECT MAX(m.server_timestamp) FROM messages m WHERE m.conversation_id = c.id) as last_message_at
     FROM conversations c
     JOIN conversation_members cm ON cm.conversation_id = c.id AND cm.user_id = ?
     WHERE 1=1 ${archivedFilter}
     ORDER BY (cm.pinned_at IS NOT NULL) DESC, cm.pinned_at ASC, last_message_at DESC NULLS LAST`,
  )
    .bind(session.userId)
    .all();

  const conversations = result.results.map((row: Record<string, unknown>) => ({
    id: row.id,
    type: row.type,
    name: row.encrypted_meta,
    members: JSON.parse(row.members as string || '[]'),
    muted: !!row.muted_at,
    archived: !!row.archived_at,
    pinned: !!row.pinned_at,
    chat_theme: row.chat_theme || null,
    media_expiry: row.media_expiry || null,
    voice_expiry: row.voice_expiry || null,
    call_history_expiry: row.call_history_expiry || null,
    burn_on_read: !!(row.burn_on_read),
    last_message_at: row.last_message_at
      ? new Date((row.last_message_at as number) * 1000).toISOString()
      : null,
  }));

  return jsonResponse({ conversations });
}
