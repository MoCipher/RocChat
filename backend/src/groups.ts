/**
 * RocChat Backend — Group Moderation
 *
 * Endpoints for conversation owners / admins to manage members:
 *
 *   POST   /api/groups/:id/promote   { user_id, role }     -> change role (admin|moderator|member)
 *   POST   /api/groups/:id/kick      { user_id }           -> remove member
 *   POST   /api/groups/:id/mute      { user_id, until }    -> mute a member for N seconds (0 = unmute)
 *   GET    /api/groups/:id/members                         -> list members with roles & mute status
 *
 * Role hierarchy: owner > admin > moderator > member.
 * - owner: single creator; cannot be demoted, only transferred.
 * - admin: can promote to admin/moderator, kick any non-owner, mute.
 * - moderator: can kick members (not admins/owners), mute members.
 * - member: no moderation privileges.
 *
 * The role column already exists on `conversation_members` (migration 0008).
 * We add a `muted_until INTEGER` column via lazy ALTER TABLE on first use.
 */

import type { Env } from './index.js';
import type { Session } from './middleware.js';
import { jsonResponse, apiError } from './middleware.js';

type Role = 'owner' | 'admin' | 'moderator' | 'member';

const ROLE_RANK: Record<Role, number> = {
  owner: 4, admin: 3, moderator: 2, member: 1,
};

let mutedColumnEnsured = false;
async function ensureMutedColumn(env: Env): Promise<void> {
  if (mutedColumnEnsured) return;
  try {
    await env.DB.prepare('ALTER TABLE conversation_members ADD COLUMN muted_until INTEGER').run();
  } catch { /* column already exists */ }
  mutedColumnEnsured = true;
}

interface MemberRow {
  user_id: string;
  role: Role;
  muted_until: number | null;
}

async function getMember(env: Env, convId: string, userId: string): Promise<MemberRow | null> {
  await ensureMutedColumn(env);
  const r = await env.DB.prepare(
    'SELECT user_id, role, muted_until FROM conversation_members WHERE conversation_id = ? AND user_id = ?'
  ).bind(convId, userId).first<MemberRow>();
  return r;
}

function canActOn(actor: Role, target: Role): boolean {
  // Actor must outrank target, and neither can be owner (owner handled specially).
  return ROLE_RANK[actor] > ROLE_RANK[target];
}

export async function handleGroups(
  request: Request,
  env: Env,
  session: Session,
  url: URL,
): Promise<Response> {
  const path = url.pathname;

  // GET /api/groups/:id/members
  const membersMatch = path.match(/^\/api\/groups\/([^/]+)\/members$/);
  if (membersMatch && request.method === 'GET') {
    const convId = membersMatch[1];
    await ensureMutedColumn(env);
    // Requester must be a member.
    const me = await getMember(env, convId, session.userId);
    if (!me) return apiError('FORBIDDEN', 'Not a member');
    const rows = await env.DB.prepare(
      `SELECT cm.user_id, cm.role, cm.muted_until, cm.joined_at, u.username
         FROM conversation_members cm
         JOIN users u ON u.id = cm.user_id
        WHERE cm.conversation_id = ?
        ORDER BY CASE cm.role
                   WHEN 'owner' THEN 0 WHEN 'admin' THEN 1
                   WHEN 'moderator' THEN 2 ELSE 3 END,
                 cm.joined_at`
    ).bind(convId).all();
    return jsonResponse({ members: rows.results });
  }

  // POST /api/groups/:id/promote
  const promoteMatch = path.match(/^\/api\/groups\/([^/]+)\/promote$/);
  if (promoteMatch && request.method === 'POST') {
    const convId = promoteMatch[1];
    const body = await request.json() as { user_id?: string; role?: Role };
    const targetId = body.user_id;
    const newRole = body.role;
    if (!targetId || !newRole) return apiError('BAD_REQUEST', 'user_id + role required');
    if (!['admin', 'moderator', 'member'].includes(newRole)) {
      return apiError('BAD_REQUEST', 'role must be admin|moderator|member');
    }

    const me = await getMember(env, convId, session.userId);
    if (!me) return apiError('FORBIDDEN', 'Not a member');
    if (me.role !== 'owner' && me.role !== 'admin') {
      return apiError('FORBIDDEN', 'Only owner/admin can promote');
    }
    const target = await getMember(env, convId, targetId);
    if (!target) return apiError('NOT_FOUND', 'User not in conversation');
    if (target.role === 'owner') return apiError('FORBIDDEN', 'Cannot change owner role');
    // Admin cannot promote someone to their own rank unless they are owner.
    if (me.role === 'admin' && newRole === 'admin') {
      return apiError('FORBIDDEN', 'Only owner can create admins');
    }

    await env.DB.prepare(
      'UPDATE conversation_members SET role = ? WHERE conversation_id = ? AND user_id = ?'
    ).bind(newRole, convId, targetId).run();
    return jsonResponse({ ok: true, user_id: targetId, role: newRole });
  }

  // POST /api/groups/:id/kick
  const kickMatch = path.match(/^\/api\/groups\/([^/]+)\/kick$/);
  if (kickMatch && request.method === 'POST') {
    const convId = kickMatch[1];
    const body = await request.json() as { user_id?: string };
    const targetId = body.user_id;
    if (!targetId) return apiError('BAD_REQUEST', 'user_id required');

    const me = await getMember(env, convId, session.userId);
    if (!me) return apiError('FORBIDDEN', 'Not a member');
    if (me.role === 'member') return apiError('FORBIDDEN', 'Members cannot kick');
    const target = await getMember(env, convId, targetId);
    if (!target) return apiError('NOT_FOUND', 'User not in conversation');
    if (target.role === 'owner') return apiError('FORBIDDEN', 'Cannot kick owner');
    if (!canActOn(me.role, target.role)) {
      return apiError('FORBIDDEN', 'Insufficient role to kick this member');
    }

    await env.DB.prepare(
      'DELETE FROM conversation_members WHERE conversation_id = ? AND user_id = ?'
    ).bind(convId, targetId).run();
    return jsonResponse({ ok: true });
  }

  // POST /api/groups/:id/mute
  const muteMatch = path.match(/^\/api\/groups\/([^/]+)\/mute$/);
  if (muteMatch && request.method === 'POST') {
    const convId = muteMatch[1];
    const body = await request.json() as { user_id?: string; until?: number };
    const targetId = body.user_id;
    const until = Number(body.until ?? 0); // 0 = unmute
    if (!targetId) return apiError('BAD_REQUEST', 'user_id required');

    const me = await getMember(env, convId, session.userId);
    if (!me) return apiError('FORBIDDEN', 'Not a member');
    if (me.role === 'member') return apiError('FORBIDDEN', 'Members cannot mute');
    const target = await getMember(env, convId, targetId);
    if (!target) return apiError('NOT_FOUND', 'User not in conversation');
    if (target.role === 'owner' || !canActOn(me.role, target.role)) {
      return apiError('FORBIDDEN', 'Insufficient role to mute this member');
    }

    await ensureMutedColumn(env);
    const value = until > 0 ? Math.floor(until) : null;
    await env.DB.prepare(
      'UPDATE conversation_members SET muted_until = ? WHERE conversation_id = ? AND user_id = ?'
    ).bind(value, convId, targetId).run();
    return jsonResponse({ ok: true, muted_until: value });
  }

  return apiError('NOT_FOUND', 'Unknown group endpoint');
}
