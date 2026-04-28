import type { Env } from './index.js';
import { jsonResponse, errorResponse, logEvent, type Session } from './middleware.js';

function parseJsonSafe(request: Request): Promise<Record<string, unknown>> {
  return request.json().catch(() => ({} as Record<string, unknown>));
}

export async function handleMeetings(
  request: Request,
  env: Env,
  session: Session,
  url: URL,
): Promise<Response> {
  const path = url.pathname;

  if (path === '/api/meetings' && request.method === 'POST') {
    const body = await parseJsonSafe(request);
    const title = String(body.title || 'Secure meeting').trim().slice(0, 120);
    const conversationId = String(body.conversation_id || '').trim();
    if (!conversationId) return errorResponse('conversation_id required', 400);
    const meetingId = crypto.randomUUID();
    const now = Math.floor(Date.now() / 1000);
    const startAt = Number(body.start_at || now);
    const mediaMode = String(body.media_mode || 'sfu') === 'mesh' ? 'mesh' : 'sfu';
    await env.DB.prepare(
      `INSERT INTO meetings (id, conversation_id, host_user_id, title, status, media_mode, starts_at, created_at)
       VALUES (?, ?, ?, ?, 'scheduled', ?, ?, ?)`,
    ).bind(meetingId, conversationId, session.userId, title, mediaMode, startAt, now).run();
    await env.DB.prepare(
      `INSERT INTO meeting_participants (meeting_id, user_id, role, state, joined_at)
       VALUES (?, ?, 'host', 'active', ?)`,
    ).bind(meetingId, session.userId, now).run();
    logEvent('info', 'meeting_created', { meeting_id: meetingId, host_user_id: session.userId, media_mode: mediaMode });
    return jsonResponse({
      meeting_id: meetingId,
      join_link: `/meeting/${meetingId}`,
      media_mode: mediaMode,
      status: 'scheduled',
    }, 201);
  }

  if (path === '/api/meetings' && request.method === 'GET') {
    const rows = await env.DB.prepare(
      `SELECT id, conversation_id, host_user_id, title, status, media_mode, starts_at, ends_at, created_at
       FROM meetings
       WHERE host_user_id = ?
       ORDER BY created_at DESC
       LIMIT 100`,
    ).bind(session.userId).all();
    return jsonResponse({ meetings: rows.results || [] });
  }

  const joinMatch = path.match(/^\/api\/meetings\/([^/]+)\/join$/);
  if (joinMatch && request.method === 'POST') {
    const meetingId = joinMatch[1];
    const body = await parseJsonSafe(request);
    const role = String(body.role || 'participant');
    const lobby = Boolean(body.lobby);
    const now = Math.floor(Date.now() / 1000);
    await env.DB.prepare(
      `INSERT INTO meeting_participants (meeting_id, user_id, role, state, joined_at)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(meeting_id, user_id)
       DO UPDATE SET role = excluded.role, state = excluded.state, joined_at = excluded.joined_at`,
    ).bind(meetingId, session.userId, role, lobby ? 'lobby' : 'active', now).run();
    await env.DB.prepare(
      `UPDATE meetings SET status = 'live' WHERE id = ?`,
    ).bind(meetingId).run();
    const stub = env.MEETING_STATE.get(env.MEETING_STATE.idFromName(meetingId));
    await stub.fetch(new Request('https://meeting/event', {
      method: 'POST',
      body: JSON.stringify({
        meetingId,
        action: 'join',
        actorUserId: session.userId,
        role,
      }),
    }));
    logEvent('info', 'meeting_join', { meeting_id: meetingId, user_id: session.userId, role });
    return jsonResponse({ ok: true, meeting_id: meetingId, role, lobby });
  }

  const eventMatch = path.match(/^\/api\/meetings\/([^/]+)\/event$/);
  if (eventMatch && request.method === 'POST') {
    const meetingId = eventMatch[1];
    const body = await parseJsonSafe(request);
    const action = String(body.action || '').trim();
    if (!action) return errorResponse('action required', 400);
    const meeting = await env.DB.prepare(
      `SELECT host_user_id FROM meetings WHERE id = ?`,
    ).bind(meetingId).first<{ host_user_id: string }>();
    if (!meeting) return errorResponse('Meeting not found', 404);
    const hostOnly = new Set(['host_mute_all', 'host_lock_room', 'host_unlock_room', 'host_remove_participant', 'lobby_admit', 'lobby_deny']);
    if (hostOnly.has(action) && meeting.host_user_id !== session.userId) {
      return errorResponse('Host permissions required', 403);
    }
    const stub = env.MEETING_STATE.get(env.MEETING_STATE.idFromName(meetingId));
    const rsp = await stub.fetch(new Request('https://meeting/event', {
      method: 'POST',
      body: JSON.stringify({
        meetingId,
        action,
        actorUserId: session.userId,
        targetUserId: body.target_user_id || null,
        role: body.role || null,
        mediaMode: body.media_mode || null,
      }),
    }));
    const state = await rsp.json().catch(() => ({}));
    logEvent('info', 'meeting_event', { meeting_id: meetingId, user_id: session.userId, action });
    return jsonResponse({ ok: true, state });
  }

  const stateMatch = path.match(/^\/api\/meetings\/([^/]+)\/state$/);
  if (stateMatch && request.method === 'GET') {
    const meetingId = stateMatch[1];
    const stub = env.MEETING_STATE.get(env.MEETING_STATE.idFromName(meetingId));
    const rsp = await stub.fetch(new Request('https://meeting/state', { method: 'GET' }));
    const state = await rsp.json().catch(() => ({}));
    return jsonResponse(state);
  }

  return errorResponse('Not found', 404);
}
