/**
 * RocChat Backend — Pre-Key Bundle Management
 *
 * Handles X3DH pre-key bundles: upload, fetch, replenish.
 */

import type { Env } from './index.js';
import type { Session } from './middleware.js';
import { jsonResponse, errorResponse } from './middleware.js';
import { signalPreKeyRefill } from './notifications.js';

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

  // GET /api/keys/refill-signal — check if a refill signal was written for this user (used by SW periodic sync)
  if (path === '/api/keys/refill-signal' && request.method === 'GET') {
    const sig = await env.KV.get(`refill_signal:${session.userId}`);
    if (sig !== null) {
      await env.KV.delete(`refill_signal:${session.userId}`);
      return jsonResponse({ refill: true, remaining: parseInt(sig, 10) });
    }
    return jsonResponse({ refill: false });
  }

  // PUT /api/keys/encrypted-bundle — replace this user's encrypted private-keys
  // blob (the AES-GCM-wrapped vault holding identity priv, SPK priv, OPK privs,
  // and now identity DH priv). Used to migrate legacy accounts to multi-device
  // E2E without a full re-registration. The blob is opaque to the server.
  if (path === '/api/keys/encrypted-bundle' && request.method === 'PUT') {
    const body = (await request.json()) as { encrypted_keys?: string };
    const blob = body.encrypted_keys;
    if (!blob || typeof blob !== 'string') return errorResponse('Missing encrypted_keys', 400);
    // Sanity cap so this isn't abused as cheap KV-style storage. The real bundle
    // is well under 32 KB even with 100 OPKs.
    if (blob.length > 64 * 1024) return errorResponse('Encrypted bundle too large', 413);
    await env.DB.prepare(
      'UPDATE users SET identity_private_encrypted = ? WHERE id = ?',
    ).bind(blob, session.userId).run();
    return jsonResponse({ ok: true });
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

  const bundle = {
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
  };

  // Check if target user's OTPK count has dropped below threshold and write a refill signal (fire-and-forget)
  void (async () => {
    try {
      const remaining = await env.DB.prepare(
        'SELECT COUNT(*) as c FROM one_time_pre_keys WHERE user_id = ? AND used = 0',
      ).bind(targetUserId).first<{ c: number }>();
      if ((remaining?.c ?? 0) < 10) {
        await signalPreKeyRefill(env, targetUserId, remaining?.c ?? 0);
      }
    } catch { /* non-critical */ }
  })();

  return jsonResponse(bundle);
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

  // Log key rotation for transparency audit
  try {
    const fp = body.publicKey.slice(0, 16);
    await env.DB.prepare(
      `INSERT INTO key_audit_log (id, user_id, event_type, new_key_fingerprint)
       VALUES (?, ?, 'signed_prekey_rotation', ?)`,
    ).bind(crypto.randomUUID(), session.userId, fp).run();
  } catch { /* table may not exist yet */ }

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
