/**
 * RocChat Backend — Pre-Key Bundle Management
 *
 * Handles X3DH pre-key bundles: upload, fetch, replenish.
 */

import type { Env } from './index.js';
import type { Session } from './middleware.js';
import { jsonResponse, errorResponse } from './middleware.js';

export async function handleKeys(
  request: Request,
  env: Env,
  session: Session,
  url: URL,
): Promise<Response> {
  const path = url.pathname;

  // GET /api/keys/bundle/:userId — fetch a user's pre-key bundle for X3DH
  if (path.startsWith('/api/keys/bundle/') && request.method === 'GET') {
    const targetUserId = path.split('/api/keys/bundle/')[1];
    if (!targetUserId) return errorResponse('Missing user ID', 400);
    return getBundle(env, targetUserId);
  }

  // POST /api/keys/prekeys — upload new one-time pre-keys
  if (path === '/api/keys/prekeys' && request.method === 'POST') {
    return uploadPreKeys(request, env, session);
  }

  // PUT /api/keys/signed — rotate signed pre-key
  if (path === '/api/keys/signed' && request.method === 'PUT') {
    return rotateSignedPreKey(request, env, session);
  }

  // GET /api/keys/count — check how many unused one-time pre-keys remain
  if (path === '/api/keys/count' && request.method === 'GET') {
    return getPreKeyCount(env, session);
  }

  return errorResponse('Not found', 404);
}

async function getBundle(env: Env, targetUserId: string): Promise<Response> {
  // Get user's identity keys
  const user = await env.DB.prepare(
    'SELECT identity_key, identity_dh_key FROM users WHERE id = ?',
  )
    .bind(targetUserId)
    .first<{ identity_key: string; identity_dh_key: string }>();

  if (!user) {
    return errorResponse('User not found', 404);
  }

  // Get latest signed pre-key
  const signedPreKey = await env.DB.prepare(
    'SELECT id, public_key, signature FROM signed_pre_keys WHERE user_id = ? ORDER BY created_at DESC LIMIT 1',
  )
    .bind(targetUserId)
    .first<{ id: number; public_key: string; signature: string }>();

  if (!signedPreKey) {
    return errorResponse('No signed pre-key available', 404);
  }

  // Atomically claim one unused one-time pre-key. RETURNING ensures we only
  // observe the key we actually marked used; two concurrent requests cannot
  // both claim the same row.
  let oneTimePreKey: { id: number; public_key: string } | null = null;
  for (let attempt = 0; attempt < 3; attempt++) {
    const candidate = await env.DB.prepare(
      'SELECT id, public_key FROM one_time_pre_keys WHERE user_id = ? AND used = 0 ORDER BY id ASC LIMIT 1',
    )
      .bind(targetUserId)
      .first<{ id: number; public_key: string }>();
    if (!candidate) break;
    const claim = await env.DB.prepare(
      'UPDATE one_time_pre_keys SET used = 1 WHERE user_id = ? AND id = ? AND used = 0',
    )
      .bind(targetUserId, candidate.id)
      .run();
    if (claim.meta.changes && claim.meta.changes > 0) {
      oneTimePreKey = candidate;
      break;
    }
    // Another request claimed it first — retry.
  }

  return jsonResponse({
    identityKey: user.identity_key,
    identityDHKey: user.identity_dh_key,
    signedPreKey: {
      id: signedPreKey.id,
      publicKey: signedPreKey.public_key,
      signature: signedPreKey.signature,
    },
    oneTimePreKey: oneTimePreKey
      ? { id: oneTimePreKey.id, publicKey: oneTimePreKey.public_key }
      : undefined,
  });
}

async function uploadPreKeys(request: Request, env: Env, session: Session): Promise<Response> {
  const body = await request.json() as {
    preKeys?: Array<{ id: number; publicKey: string }>;
  };

  if (!body.preKeys?.length) {
    return errorResponse('No pre-keys provided', 400);
  }

  // Limit batch size
  if (body.preKeys.length > 100) {
    return errorResponse('Maximum 100 pre-keys per batch', 400);
  }

  const statements = body.preKeys.map((pk) =>
    env.DB.prepare(
      'INSERT OR IGNORE INTO one_time_pre_keys (id, user_id, public_key) VALUES (?, ?, ?)',
    ).bind(pk.id, session.userId, pk.publicKey),
  );

  await env.DB.batch(statements);

  return jsonResponse({ uploaded: body.preKeys.length });
}

async function rotateSignedPreKey(
  request: Request,
  env: Env,
  session: Session,
): Promise<Response> {
  const body = await request.json() as {
    id?: number;
    publicKey?: string;
    signature?: string;
  };

  if (!body.id || !body.publicKey || !body.signature) {
    return errorResponse('Missing signed pre-key fields', 400);
  }

  await env.DB.prepare(
    'INSERT INTO signed_pre_keys (id, user_id, public_key, signature) VALUES (?, ?, ?, ?)',
  )
    .bind(body.id, session.userId, body.publicKey, body.signature)
    .run();

  // Clean up old signed pre-keys (keep last 2)
  await env.DB.prepare(
    `DELETE FROM signed_pre_keys WHERE user_id = ? AND id NOT IN (
      SELECT id FROM signed_pre_keys WHERE user_id = ? ORDER BY created_at DESC LIMIT 2
    )`,
  )
    .bind(session.userId, session.userId)
    .run();

  return jsonResponse({ ok: true });
}

async function getPreKeyCount(env: Env, session: Session): Promise<Response> {
  const result = await env.DB.prepare(
    'SELECT COUNT(*) as count FROM one_time_pre_keys WHERE user_id = ? AND used = 0',
  )
    .bind(session.userId)
    .first<{ count: number }>();

  return jsonResponse({ count: result?.count || 0 });
}
