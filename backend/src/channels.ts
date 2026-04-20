/**
 * RocChat Backend — Channels & Communities
 *
 * Channels are one-to-many broadcast conversations:
 *   - Admins post, subscribers read
 *   - Discoverable via search (public channels)
 *   - Still E2E encrypted (Sender Keys)
 *
 * Communities group multiple channels under one namespace.
 *
 * Endpoints:
 *   POST   /api/channels                  -> create channel
 *   GET    /api/channels/discover         -> search public channels
 *   GET    /api/channels/:id              -> get channel info
 *   PATCH  /api/channels/:id             -> update channel (admin only)
 *   POST   /api/channels/:id/subscribe    -> subscribe
 *   DELETE /api/channels/:id/subscribe    -> unsubscribe
 *   POST   /api/channels/:id/post         -> broadcast message (admin only)
 *   POST   /api/communities               -> create community
 *   GET    /api/communities/discover      -> search public communities
 *   GET    /api/communities/:id           -> get community + channels
 *   POST   /api/communities/:id/join      -> join community
 *   DELETE /api/communities/:id/leave     -> leave community
 */

import type { Env } from './index.js';
import type { Session } from './middleware.js';
import { jsonResponse, apiError } from './middleware.js';

export async function handleChannels(
  request: Request,
  env: Env,
  session: Session,
  url: URL,
): Promise<Response | null> {
  const path = url.pathname;

  // POST /api/channels — create channel
  if (path === '/api/channels' && request.method === 'POST') {
    const body = await request.json() as {
      name?: string; description?: string; is_public?: boolean; tags?: string; community_id?: string;
    };
    if (!body.name || body.name.length < 2 || body.name.length > 64) {
      return apiError('BAD_REQUEST', 'Channel name must be 2-64 characters');
    }
    const id = crypto.randomUUID();
    const convId = crypto.randomUUID();

    // Create conversation entry (type: channel)
    await env.DB.prepare(
      `INSERT INTO conversations (id, type, name) VALUES (?, 'group', ?)`
    ).bind(convId, body.name).run();

    // Create channel metadata
    await env.DB.prepare(
      `INSERT INTO channels (id, name, description, is_public, tags, community_id, created_by)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    ).bind(
      convId, body.name, body.description || '', body.is_public !== false ? 1 : 0,
      body.tags || '', body.community_id || null, session.userId
    ).run();

    // Add creator as admin
    await env.DB.prepare(
      `INSERT INTO conversation_members (conversation_id, user_id, role) VALUES (?, ?, 'admin')`
    ).bind(convId, session.userId).run();

    return jsonResponse({ ok: true, channel_id: convId, name: body.name });
  }

  // GET /api/channels/discover?q=...&tag=...
  if (path === '/api/channels/discover' && request.method === 'GET') {
    const q = url.searchParams.get('q') || '';
    const tag = url.searchParams.get('tag') || '';
    let query = `SELECT id, name, description, subscriber_count, tags, avatar_url FROM channels WHERE is_public = 1`;
    const binds: string[] = [];

    if (q) {
      query += ` AND (name LIKE ? OR description LIKE ?)`;
      binds.push(`%${q}%`, `%${q}%`);
    }
    if (tag) {
      query += ` AND tags LIKE ?`;
      binds.push(`%${tag}%`);
    }
    query += ` ORDER BY subscriber_count DESC LIMIT 50`;

    const stmt = env.DB.prepare(query);
    const results = binds.length > 0 ? await stmt.bind(...binds).all() : await stmt.all();
    return jsonResponse({ channels: results.results });
  }

  // GET /api/channels/:id
  const channelInfoMatch = path.match(/^\/api\/channels\/([^/]+)$/);
  if (channelInfoMatch && request.method === 'GET') {
    const channelId = channelInfoMatch[1];
    const channel = await env.DB.prepare(
      `SELECT c.*, cm.role as my_role FROM channels c
       LEFT JOIN conversation_members cm ON cm.conversation_id = c.id AND cm.user_id = ?
       WHERE c.id = ?`
    ).bind(session.userId, channelId).first();
    if (!channel) return apiError('NOT_FOUND', 'Channel not found');
    return jsonResponse({ channel });
  }

  // PATCH /api/channels/:id — update (admin only)
  const channelUpdateMatch = path.match(/^\/api\/channels\/([^/]+)$/);
  if (channelUpdateMatch && request.method === 'PATCH') {
    const channelId = channelUpdateMatch[1];
    const member = await env.DB.prepare(
      `SELECT role FROM conversation_members WHERE conversation_id = ? AND user_id = ?`
    ).bind(channelId, session.userId).first<{ role: string }>();
    if (!member || member.role === 'member') return apiError('FORBIDDEN', 'Admin only');

    const body = await request.json() as { name?: string; description?: string; topic?: string; tags?: string };
    const updates: string[] = [];
    const vals: any[] = [];
    if (body.name) { updates.push('name = ?'); vals.push(body.name); }
    if (body.description !== undefined) { updates.push('description = ?'); vals.push(body.description); }
    if (body.topic !== undefined) { updates.push('topic = ?'); vals.push(body.topic); }
    if (body.tags !== undefined) { updates.push('tags = ?'); vals.push(body.tags); }
    if (updates.length === 0) return apiError('BAD_REQUEST', 'Nothing to update');

    vals.push(channelId);
    await env.DB.prepare(`UPDATE channels SET ${updates.join(', ')} WHERE id = ?`).bind(...vals).run();
    return jsonResponse({ ok: true });
  }

  // POST /api/channels/:id/subscribe
  const subMatch = path.match(/^\/api\/channels\/([^/]+)\/subscribe$/);
  if (subMatch && request.method === 'POST') {
    const channelId = subMatch[1];
    const channel = await env.DB.prepare('SELECT id FROM channels WHERE id = ?').bind(channelId).first();
    if (!channel) return apiError('NOT_FOUND', 'Channel not found');

    await env.DB.prepare(
      `INSERT OR IGNORE INTO conversation_members (conversation_id, user_id, role) VALUES (?, ?, 'member')`
    ).bind(channelId, session.userId).run();
    await env.DB.prepare(
      `UPDATE channels SET subscriber_count = subscriber_count + 1 WHERE id = ?`
    ).bind(channelId).run();
    return jsonResponse({ ok: true, subscribed: true });
  }

  // DELETE /api/channels/:id/subscribe — unsubscribe
  if (subMatch && request.method === 'DELETE') {
    const channelId = subMatch[1];
    await env.DB.prepare(
      `DELETE FROM conversation_members WHERE conversation_id = ? AND user_id = ?`
    ).bind(channelId, session.userId).run();
    await env.DB.prepare(
      `UPDATE channels SET subscriber_count = MAX(0, subscriber_count - 1) WHERE id = ?`
    ).bind(channelId).run();
    return jsonResponse({ ok: true, subscribed: false });
  }

  // POST /api/channels/:id/post — broadcast (admin only)
  const postMatch = path.match(/^\/api\/channels\/([^/]+)\/post$/);
  if (postMatch && request.method === 'POST') {
    const channelId = postMatch[1];
    const member = await env.DB.prepare(
      `SELECT role FROM conversation_members WHERE conversation_id = ? AND user_id = ?`
    ).bind(channelId, session.userId).first<{ role: string }>();
    if (!member || member.role === 'member') return apiError('FORBIDDEN', 'Only admins can post to channels');

    const body = await request.json() as { ciphertext: string; iv: string; ratchet_header: string; message_type?: string };
    const msgId = crypto.randomUUID();
    await env.DB.prepare(
      `INSERT INTO messages (id, conversation_id, sender_id, ciphertext, iv, ratchet_header, message_type, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, unixepoch())`
    ).bind(msgId, channelId, session.userId, body.ciphertext, body.iv, body.ratchet_header, body.message_type || 'text').run();

    // Broadcast via Durable Object
    const roomId = env.CHAT_ROOM.idFromName(channelId);
    const room = env.CHAT_ROOM.get(roomId);
    await room.fetch(new Request('https://internal/broadcast', {
      method: 'POST',
      body: JSON.stringify({
        type: 'new_message',
        payload: { id: msgId, conversation_id: channelId, sender_id: session.userId, message_type: body.message_type || 'text', ciphertext: body.ciphertext, iv: body.iv, ratchet_header: body.ratchet_header },
      }),
    }));
    return jsonResponse({ ok: true, message_id: msgId });
  }

  // ─── Communities ───

  // POST /api/communities — create
  if (path === '/api/communities' && request.method === 'POST') {
    const body = await request.json() as { name?: string; description?: string; is_public?: boolean };
    if (!body.name || body.name.length < 2 || body.name.length > 64) {
      return apiError('BAD_REQUEST', 'Name must be 2-64 characters');
    }
    const id = crypto.randomUUID();
    await env.DB.prepare(
      `INSERT INTO communities (id, name, description, owner_id, is_public) VALUES (?, ?, ?, ?, ?)`
    ).bind(id, body.name, body.description || '', session.userId, body.is_public !== false ? 1 : 0).run();
    await env.DB.prepare(
      `INSERT INTO community_members (community_id, user_id, role) VALUES (?, ?, 'owner')`
    ).bind(id, session.userId).run();
    return jsonResponse({ ok: true, community_id: id });
  }

  // GET /api/communities/discover?q=...
  if (path === '/api/communities/discover' && request.method === 'GET') {
    const q = url.searchParams.get('q') || '';
    let query = `SELECT id, name, description, member_count, avatar_url FROM communities WHERE is_public = 1`;
    const binds: string[] = [];
    if (q) {
      query += ` AND (name LIKE ? OR description LIKE ?)`;
      binds.push(`%${q}%`, `%${q}%`);
    }
    query += ` ORDER BY member_count DESC LIMIT 50`;
    const stmt = env.DB.prepare(query);
    const results = binds.length > 0 ? await stmt.bind(...binds).all() : await stmt.all();
    return jsonResponse({ communities: results.results });
  }

  // GET /api/communities/:id — info + channels
  const communityMatch = path.match(/^\/api\/communities\/([^/]+)$/);
  if (communityMatch && request.method === 'GET') {
    const commId = communityMatch[1];
    const community = await env.DB.prepare(
      `SELECT c.*, cm.role as my_role FROM communities c
       LEFT JOIN community_members cm ON cm.community_id = c.id AND cm.user_id = ?
       WHERE c.id = ?`
    ).bind(session.userId, commId).first();
    if (!community) return apiError('NOT_FOUND', 'Community not found');

    const channels = await env.DB.prepare(
      `SELECT id, name, description, subscriber_count, topic FROM channels WHERE community_id = ?`
    ).bind(commId).all();
    return jsonResponse({ community, channels: channels.results });
  }

  // POST /api/communities/:id/join
  const joinMatch = path.match(/^\/api\/communities\/([^/]+)\/join$/);
  if (joinMatch && request.method === 'POST') {
    const commId = joinMatch[1];
    await env.DB.prepare(
      `INSERT OR IGNORE INTO community_members (community_id, user_id, role) VALUES (?, ?, 'member')`
    ).bind(commId, session.userId).run();
    await env.DB.prepare(
      `UPDATE communities SET member_count = member_count + 1 WHERE id = ?`
    ).bind(commId).run();
    return jsonResponse({ ok: true, joined: true });
  }

  // DELETE /api/communities/:id/leave
  const leaveMatch = path.match(/^\/api\/communities\/([^/]+)\/leave$/);
  if (leaveMatch && request.method === 'DELETE') {
    const commId = leaveMatch[1];
    await env.DB.prepare(
      `DELETE FROM community_members WHERE community_id = ? AND user_id = ?`
    ).bind(commId, session.userId).run();
    await env.DB.prepare(
      `UPDATE communities SET member_count = MAX(0, member_count - 1) WHERE id = ?`
    ).bind(commId).run();
    return jsonResponse({ ok: true, left: true });
  }

  return null; // not handled
}
