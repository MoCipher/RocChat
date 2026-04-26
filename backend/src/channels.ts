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
 *   POST   /api/channels/:id/schedule     -> schedule a post (admin only)
 *   GET    /api/channels/:id/scheduled    -> list scheduled posts (admin)
 *   DELETE /api/channels/:id/scheduled/:p -> cancel scheduled post
 *   POST   /api/channels/:id/pin/:msgId   -> pin a post (admin only)
 *   DELETE /api/channels/:id/pin          -> unpin (admin only)
 *   POST   /api/channels/:id/read/:msgId  -> mark post as read (analytics)
 *   GET    /api/channels/:id/analytics    -> post read counts (admin only)
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
    if (!body.ciphertext || body.ciphertext.length > 256 * 1024) {
      return apiError('BAD_REQUEST', 'Ciphertext missing or too large');
    }
    if (body.ratchet_header && body.ratchet_header.length > 2048) {
      return apiError('BAD_REQUEST', 'Ratchet header too large');
    }
    const msgId = crypto.randomUUID();
    // Store as flat JSON in the canonical `encrypted` column so getMessages can parse it.
    const encrypted = JSON.stringify({
      ciphertext: body.ciphertext,
      iv: body.iv || '',
      tag: '',
      ratchet_header: body.ratchet_header || '',
      message_type: body.message_type || 'text',
    });
    await env.DB.prepare(
      `INSERT INTO messages (id, conversation_id, sender_id, encrypted, server_timestamp)
       VALUES (?, ?, ?, ?, unixepoch())`
    ).bind(msgId, channelId, session.userId, encrypted).run();

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

  // PATCH /api/communities/:id — update (owner/admin only)
  if (communityMatch && request.method === 'PATCH') {
    const commId = communityMatch[1];
    const role = await env.DB.prepare(
      `SELECT role FROM community_members WHERE community_id = ? AND user_id = ?`
    ).bind(commId, session.userId).first<{ role: string }>();
    if (!role || (role.role !== 'owner' && role.role !== 'admin')) {
      return apiError('FORBIDDEN', 'Only owner/admin can update community');
    }
    const body = await request.json() as { name?: string; description?: string; is_public?: boolean };
    if (body.name !== undefined && (body.name.length < 2 || body.name.length > 64)) {
      return apiError('BAD_REQUEST', 'Name must be 2-64 characters');
    }
    if (body.description !== undefined && body.description.length > 200) {
      return apiError('BAD_REQUEST', 'Description must be under 200 characters');
    }
    const sets: string[] = [];
    const vals: (string | number)[] = [];
    if (body.name !== undefined) { sets.push('name = ?'); vals.push(body.name); }
    if (body.description !== undefined) { sets.push('description = ?'); vals.push(body.description); }
    if (body.is_public !== undefined) { sets.push('is_public = ?'); vals.push(body.is_public ? 1 : 0); }
    if (sets.length > 0) {
      vals.push(commId);
      await env.DB.prepare(`UPDATE communities SET ${sets.join(', ')} WHERE id = ?`).bind(...vals).run();
    }
    return jsonResponse({ ok: true });
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

  // ─── Channel Sender-Key Envelopes (E2E) ───
  //
  // Each channel has a symmetric key generated by an admin client and wrapped
  // (ECIES-style) per-subscriber using their identity DH public key. Server
  // never sees the channel symmetric key — only the wrapped envelopes.

  // POST /api/channels/:id/keys — admin uploads envelopes for one or more recipients
  const keysUploadMatch = path.match(/^\/api\/channels\/([^/]+)\/keys$/);
  if (keysUploadMatch && request.method === 'POST') {
    const channelId = keysUploadMatch[1];
    const member = await env.DB.prepare(
      `SELECT role FROM conversation_members WHERE conversation_id = ? AND user_id = ?`
    ).bind(channelId, session.userId).first<{ role: string }>();
    if (!member || member.role === 'member') return apiError('FORBIDDEN', 'Admin only');

    const body = await request.json() as {
      envelopes: Array<{
        recipient_id: string;
        ephemeral_pub: string;
        ciphertext: string;
        iv: string;
        tag: string;
        key_version?: number;
      }>;
    };
    if (!Array.isArray(body.envelopes) || body.envelopes.length === 0) {
      return apiError('BAD_REQUEST', 'envelopes array required');
    }
    if (body.envelopes.length > 500) {
      return apiError('BAD_REQUEST', 'Max 500 envelopes per request');
    }

    const stmts: D1PreparedStatement[] = [];
    for (const env_ of body.envelopes) {
      // Validate sizes — these are short fixed-format base64 fields
      if (!env_.recipient_id || !env_.ephemeral_pub || !env_.ciphertext || !env_.iv || !env_.tag) continue;
      if (env_.ephemeral_pub.length > 128 || env_.ciphertext.length > 256 ||
          env_.iv.length > 64 || env_.tag.length > 64 || env_.recipient_id.length > 64) continue;
      const ver = Math.max(1, Math.min(1_000_000, env_.key_version || 1));
      stmts.push(env.DB.prepare(
        `INSERT OR REPLACE INTO channel_key_envelopes
           (channel_id, recipient_id, sender_id, ephemeral_pub, ciphertext, iv, tag, key_version)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      ).bind(channelId, env_.recipient_id, session.userId, env_.ephemeral_pub,
             env_.ciphertext, env_.iv, env_.tag, ver));
    }
    if (stmts.length > 0) await env.DB.batch(stmts);
    return jsonResponse({ ok: true, uploaded: stmts.length });
  }

  // GET /api/channels/:id/keys/me — subscriber fetches their newest envelope
  const keysMeMatch = path.match(/^\/api\/channels\/([^/]+)\/keys\/me$/);
  if (keysMeMatch && request.method === 'GET') {
    const channelId = keysMeMatch[1];
    const member = await env.DB.prepare(
      `SELECT role FROM conversation_members WHERE conversation_id = ? AND user_id = ?`
    ).bind(channelId, session.userId).first<{ role: string }>();
    if (!member) return apiError('FORBIDDEN', 'Not a subscriber');

    const env_ = await env.DB.prepare(
      `SELECT ephemeral_pub, ciphertext, iv, tag, key_version, sender_id, created_at
       FROM channel_key_envelopes
       WHERE channel_id = ? AND recipient_id = ?
       ORDER BY key_version DESC LIMIT 1`
    ).bind(channelId, session.userId).first();
    if (!env_) return jsonResponse({ envelope: null });
    return jsonResponse({ envelope: env_ });
  }

  // GET /api/channels/:id/keys/pending — admin lists subscribers without envelopes
  const keysPendingMatch = path.match(/^\/api\/channels\/([^/]+)\/keys\/pending$/);
  if (keysPendingMatch && request.method === 'GET') {
    const channelId = keysPendingMatch[1];
    const member = await env.DB.prepare(
      `SELECT role FROM conversation_members WHERE conversation_id = ? AND user_id = ?`
    ).bind(channelId, session.userId).first<{ role: string }>();
    if (!member || member.role === 'member') return apiError('FORBIDDEN', 'Admin only');

    // Subscribers who don't yet have an envelope at the latest key_version
    const latestRow = await env.DB.prepare(
      `SELECT COALESCE(MAX(key_version), 1) AS v FROM channel_key_envelopes WHERE channel_id = ?`
    ).bind(channelId).first<{ v: number }>();
    const v = latestRow?.v || 1;
    const pending = await env.DB.prepare(
      `SELECT cm.user_id, u.identity_dh_key, u.identity_key
       FROM conversation_members cm
       JOIN users u ON u.id = cm.user_id
       LEFT JOIN channel_key_envelopes e
         ON e.channel_id = cm.conversation_id AND e.recipient_id = cm.user_id AND e.key_version = ?
       WHERE cm.conversation_id = ? AND e.recipient_id IS NULL
       LIMIT 200`
    ).bind(v, channelId).all();
    return jsonResponse({ key_version: v, recipients: pending.results });
  }

  // ─── Scheduled Posts ───

  // POST /api/channels/:id/schedule — schedule a post (admin only)
  const scheduleMatch = path.match(/^\/api\/channels\/([^/]+)\/schedule$/);
  if (scheduleMatch && request.method === 'POST') {
    const channelId = scheduleMatch[1];
    const member = await env.DB.prepare(
      `SELECT role FROM conversation_members WHERE conversation_id = ? AND user_id = ?`
    ).bind(channelId, session.userId).first<{ role: string }>();
    if (!member || member.role === 'member') return apiError('FORBIDDEN', 'Admin only');

    const body = await request.json() as {
      ciphertext: string; iv: string; ratchet_header?: string; scheduled_at: number;
    };
    if (!body.ciphertext || !body.scheduled_at) return apiError('BAD_REQUEST', 'Missing fields');
    if (body.ciphertext.length > 256 * 1024) return apiError('BAD_REQUEST', 'Ciphertext too large');
    if (body.ratchet_header && body.ratchet_header.length > 2048) return apiError('BAD_REQUEST', 'Ratchet header too large');

    const id = crypto.randomUUID();
    await env.DB.prepare(
      `INSERT INTO channel_scheduled_posts (id, channel_id, author_id, ciphertext, iv, ratchet_header, scheduled_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    ).bind(id, channelId, session.userId, body.ciphertext, body.iv || '', body.ratchet_header || '', body.scheduled_at).run();
    return jsonResponse({ ok: true, scheduled_post_id: id, scheduled_at: body.scheduled_at });
  }

  // GET /api/channels/:id/scheduled — list scheduled posts (admin only)
  const listScheduledMatch = path.match(/^\/api\/channels\/([^/]+)\/scheduled$/);
  if (listScheduledMatch && request.method === 'GET') {
    const channelId = listScheduledMatch[1];
    const member = await env.DB.prepare(
      `SELECT role FROM conversation_members WHERE conversation_id = ? AND user_id = ?`
    ).bind(channelId, session.userId).first<{ role: string }>();
    if (!member || member.role === 'member') return apiError('FORBIDDEN', 'Admin only');

    const posts = await env.DB.prepare(
      `SELECT id, ciphertext, iv, ratchet_header, scheduled_at, status, created_at FROM channel_scheduled_posts
       WHERE channel_id = ? AND status = 'pending' ORDER BY scheduled_at ASC LIMIT 50`
    ).bind(channelId).all();
    return jsonResponse({ posts: posts.results });
  }

  // DELETE /api/channels/:id/scheduled/:postId — cancel scheduled post
  const cancelScheduleMatch = path.match(/^\/api\/channels\/([^/]+)\/scheduled\/([^/]+)$/);
  if (cancelScheduleMatch && request.method === 'DELETE') {
    const channelId = cancelScheduleMatch[1];
    const postId = cancelScheduleMatch[2];
    const member = await env.DB.prepare(
      `SELECT role FROM conversation_members WHERE conversation_id = ? AND user_id = ?`
    ).bind(channelId, session.userId).first<{ role: string }>();
    if (!member || member.role === 'member') return apiError('FORBIDDEN', 'Admin only');

    await env.DB.prepare(
      `UPDATE channel_scheduled_posts SET status = 'cancelled' WHERE id = ? AND channel_id = ?`
    ).bind(postId, channelId).run();
    return jsonResponse({ ok: true, cancelled: true });
  }

  // ─── Pin / Unpin ───

  // POST /api/channels/:id/pin/:messageId — pin a post (admin only)
  const pinMatch = path.match(/^\/api\/channels\/([^/]+)\/pin\/([^/]+)$/);
  if (pinMatch && request.method === 'POST') {
    const channelId = pinMatch[1];
    const messageId = pinMatch[2];
    const member = await env.DB.prepare(
      `SELECT role FROM conversation_members WHERE conversation_id = ? AND user_id = ?`
    ).bind(channelId, session.userId).first<{ role: string }>();
    if (!member || member.role === 'member') return apiError('FORBIDDEN', 'Admin only');

    await env.DB.prepare(
      `UPDATE channels SET pinned_post_id = ? WHERE id = ?`
    ).bind(messageId, channelId).run();
    return jsonResponse({ ok: true, pinned: messageId });
  }

  // DELETE /api/channels/:id/pin — unpin (admin only)
  const unpinMatch = path.match(/^\/api\/channels\/([^/]+)\/pin$/);
  if (unpinMatch && request.method === 'DELETE') {
    const channelId = unpinMatch[1];
    const member = await env.DB.prepare(
      `SELECT role FROM conversation_members WHERE conversation_id = ? AND user_id = ?`
    ).bind(channelId, session.userId).first<{ role: string }>();
    if (!member || member.role === 'member') return apiError('FORBIDDEN', 'Admin only');

    await env.DB.prepare(
      `UPDATE channels SET pinned_post_id = NULL WHERE id = ?`
    ).bind(channelId).run();
    return jsonResponse({ ok: true, pinned: null });
  }

  // ─── Channel Analytics ───

  // POST /api/channels/:id/read/:messageId — mark a channel post as read
  const readMatch = path.match(/^\/api\/channels\/([^/]+)\/read\/([^/]+)$/);
  if (readMatch && request.method === 'POST') {
    const messageId = readMatch[2];
    await env.DB.prepare(
      `INSERT OR IGNORE INTO channel_post_reads (message_id, user_id) VALUES (?, ?)`
    ).bind(messageId, session.userId).run();
    return jsonResponse({ ok: true });
  }

  // GET /api/channels/:id/analytics — get post read counts (admin only)
  const analyticsMatch = path.match(/^\/api\/channels\/([^/]+)\/analytics$/);
  if (analyticsMatch && request.method === 'GET') {
    const channelId = analyticsMatch[1];
    const member = await env.DB.prepare(
      `SELECT role FROM conversation_members WHERE conversation_id = ? AND user_id = ?`
    ).bind(channelId, session.userId).first<{ role: string }>();
    if (!member || member.role === 'member') return apiError('FORBIDDEN', 'Admin only');

    const channel = await env.DB.prepare(
      `SELECT subscriber_count FROM channels WHERE id = ?`
    ).bind(channelId).first<{ subscriber_count: number }>();

    const posts = await env.DB.prepare(
      `SELECT m.id, m.created_at, COUNT(r.user_id) as read_count
       FROM messages m
       LEFT JOIN channel_post_reads r ON r.message_id = m.id
       WHERE m.conversation_id = ?
       GROUP BY m.id
       ORDER BY m.created_at DESC
       LIMIT 50`
    ).bind(channelId).all();

    return jsonResponse({
      subscriber_count: channel?.subscriber_count || 0,
      posts: posts.results,
    });
  }

  return null; // not handled
}
