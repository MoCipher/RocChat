/**
 * RocChat Backend — Contacts & Discovery
 *
 * Username search (exact match, respects privacy settings), contact management.
 */

import type { Env } from './index.js';
import type { Session } from './middleware.js';
import { jsonResponse, errorResponse } from './middleware.js';

export async function handleContacts(
  request: Request,
  env: Env,
  session: Session,
  url: URL,
): Promise<Response> {
  const path = url.pathname;

  // GET /api/contacts/search?q=username
  if (path === '/api/contacts/search' && request.method === 'GET') {
    return searchUser(env, session, url);
  }

  // POST /api/contacts/add — add a contact
  if (path === '/api/contacts/add' && request.method === 'POST') {
    return addContact(request, env, session);
  }

  // GET /api/contacts — list contacts
  if (path === '/api/contacts' && request.method === 'GET') {
    return listContacts(env, session);
  }

  // POST /api/contacts/block — block a user
  if (path === '/api/contacts/block' && request.method === 'POST') {
    return blockUser(request, env, session);
  }

  // POST /api/contacts/verify — mark contact as verified (Safety Number)
  if (path === '/api/contacts/verify' && request.method === 'POST') {
    return verifyContact(request, env, session);
  }

  // DELETE /api/contacts/:userId — remove a contact
  if (path.startsWith('/api/contacts/') && request.method === 'DELETE') {
    const contactUserId = path.split('/api/contacts/')[1];
    if (!contactUserId || contactUserId.includes('/')) return errorResponse('Invalid path', 400);
    return removeContact(env, session, contactUserId);
  }

  return errorResponse('Not found', 404);
}

async function searchUser(env: Env, session: Session, url: URL): Promise<Response> {
  const query = url.searchParams.get('q')?.toLowerCase()?.trim();
  if (!query || query.length < 3) {
    return errorResponse('Query must be at least 3 characters', 400);
  }

  // Exact match only — no fuzzy/partial search to prevent enumeration
  const user = await env.DB.prepare(
    `SELECT id, username, display_name, identity_key
     FROM users WHERE username = ? AND discoverable = 1 AND id != ?`,
  )
    .bind(query, session.userId)
    .first<{ id: string; username: string; display_name: string; identity_key: string }>();

  // Always take same time regardless of result (prevent timing-based enumeration)
  await new Promise((r) => setTimeout(r, 50 + Math.random() * 30));

  if (!user) {
    return jsonResponse({ results: [] });
  }

  return jsonResponse({
    results: [
      {
        userId: user.id,
        username: user.username,
        displayName: user.display_name,
        identityKey: user.identity_key,
      },
    ],
  });
}

async function addContact(request: Request, env: Env, session: Session): Promise<Response> {
  const body = await request.json() as { userId?: string };
  if (!body.userId) return errorResponse('Missing userId', 400);
  if (body.userId === session.userId) return errorResponse('Cannot add yourself', 400);

  // Verify user exists
  const user = await env.DB.prepare('SELECT 1 FROM users WHERE id = ?')
    .bind(body.userId)
    .first();
  if (!user) return errorResponse('User not found', 404);

  // Check if already a contact
  const existing = await env.DB.prepare(
    'SELECT 1 FROM contacts WHERE user_id = ? AND contact_user_id = ?',
  )
    .bind(session.userId, body.userId)
    .first();

  if (existing) return jsonResponse({ ok: true, existing: true });

  // Add bidirectional contact entries
  await env.DB.batch([
    env.DB.prepare(
      'INSERT OR IGNORE INTO contacts (user_id, contact_user_id) VALUES (?, ?)',
    ).bind(session.userId, body.userId),
    env.DB.prepare(
      'INSERT OR IGNORE INTO contacts (user_id, contact_user_id) VALUES (?, ?)',
    ).bind(body.userId, session.userId),
  ]);

  return jsonResponse({ ok: true }, 201);
}

async function listContacts(env: Env, session: Session): Promise<Response> {
  const result = await env.DB.prepare(
    `SELECT u.id as userId, u.username, u.display_name as displayName,
            u.identity_key as identityKey, c.verified, c.blocked, c.created_at as addedAt
     FROM contacts c
     JOIN users u ON u.id = c.contact_user_id
     WHERE c.user_id = ?
     ORDER BY u.display_name ASC`,
  )
    .bind(session.userId)
    .all();

  return jsonResponse({ contacts: result.results });
}

async function blockUser(request: Request, env: Env, session: Session): Promise<Response> {
  const body = await request.json() as { userId?: string; blocked?: boolean };
  if (!body.userId) return errorResponse('Missing userId', 400);

  const blocked = body.blocked !== false ? 1 : 0;

  await env.DB.prepare(
    `INSERT INTO contacts (user_id, contact_user_id, blocked)
     VALUES (?, ?, ?)
     ON CONFLICT (user_id, contact_user_id) DO UPDATE SET blocked = ?`,
  )
    .bind(session.userId, body.userId, blocked, blocked)
    .run();

  return jsonResponse({ ok: true });
}

async function verifyContact(request: Request, env: Env, session: Session): Promise<Response> {
  const body = await request.json() as { userId?: string };
  if (!body.userId) return errorResponse('Missing userId', 400);

  await env.DB.prepare(
    'UPDATE contacts SET verified = 1 WHERE user_id = ? AND contact_user_id = ?',
  )
    .bind(session.userId, body.userId)
    .run();

  return jsonResponse({ ok: true });
}

async function removeContact(env: Env, session: Session, contactUserId: string): Promise<Response> {
  await env.DB.prepare(
    'DELETE FROM contacts WHERE user_id = ? AND contact_user_id = ?',
  )
    .bind(session.userId, contactUserId)
    .run();

  return jsonResponse({ ok: true });
}
