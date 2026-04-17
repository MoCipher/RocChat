/**
 * RocChat Backend — QR Code Web Login
 *
 * Flow:
 * 1. Web client calls POST /api/auth/qr/generate → gets a short-lived QR token
 * 2. Web displays QR code containing that token
 * 3. Web polls GET /api/auth/qr/poll/:token every 2s
 * 4. Mobile scans QR, calls POST /api/auth/qr/authorize with own session + QR token
 * 5. Poll returns the session_token + encrypted keys → web is logged in
 */

import type { Env } from './index.js';
import { jsonResponse, errorResponse } from './middleware.js';

const QR_TTL = 300; // 5 minutes

export async function handleQrAuth(
  request: Request,
  env: Env,
  action: 'generate' | 'poll' | 'authorize',
  url: URL,
  session?: { userId: string; deviceId: string },
): Promise<Response> {
  switch (action) {
    case 'generate':
      return generate(env);
    case 'poll':
      return poll(env, url);
    case 'authorize':
      return authorize(request, env, session);
    default:
      return errorResponse('Unknown QR action', 400);
  }
}

async function generate(env: Env): Promise<Response> {
  const token = crypto.randomUUID();
  // Store in KV with 5 min TTL, status = pending
  await env.KV.put(
    `qr:${token}`,
    JSON.stringify({ status: 'pending', created: Date.now() }),
    { expirationTtl: QR_TTL },
  );
  return jsonResponse({ token, expires_in: QR_TTL });
}

async function poll(env: Env, url: URL): Promise<Response> {
  const token = url.pathname.split('/api/auth/qr/poll/')[1];
  if (!token) return errorResponse('Missing token', 400);

  const raw = await env.KV.get(`qr:${token}`);
  if (!raw) return jsonResponse({ status: 'expired' });

  const data = JSON.parse(raw) as {
    status: string;
    session_token?: string;
    user_id?: string;
    encrypted_keys?: string;
    identity_key?: string;
  };

  if (data.status === 'authorized') {
    // One-time read: delete after retrieval
    await env.KV.delete(`qr:${token}`);
    return jsonResponse({
      status: 'authorized',
      session_token: data.session_token,
      user_id: data.user_id,
      encrypted_keys: data.encrypted_keys,
      identity_key: data.identity_key,
    });
  }

  return jsonResponse({ status: data.status });
}

async function authorize(
  request: Request,
  env: Env,
  session?: { userId: string; deviceId: string },
): Promise<Response> {
  if (!session) return errorResponse('Unauthorized', 401);

  const body = (await request.json()) as { qr_token: string };
  if (!body.qr_token) return errorResponse('Missing qr_token', 400);

  const raw = await env.KV.get(`qr:${body.qr_token}`);
  if (!raw) return errorResponse('QR code expired', 410);

  const data = JSON.parse(raw) as { status: string };
  if (data.status !== 'pending') return errorResponse('QR code already used', 409);

  // Fetch user data for the web session
  const user = await env.DB.prepare(
    'SELECT id, username, display_name, identity_key, identity_private_encrypted FROM users WHERE id = ?',
  )
    .bind(session.userId)
    .first<{
      id: string;
      username: string;
      display_name: string;
      identity_key: string;
      identity_private_encrypted: string;
    }>();

  if (!user) return errorResponse('User not found', 404);

  // Create a new session token for the web client
  const webSessionToken = crypto.randomUUID();
  const deviceId = crypto.randomUUID();
  const expiresAt = Math.floor(Date.now() / 1000) + 86400 * 7;
  // Create a devices row for the web QR session
  await env.DB.prepare(
    'INSERT OR IGNORE INTO devices (id, user_id, name, platform, created_at, last_active) VALUES (?, ?, ?, ?, unixepoch(), unixepoch())'
  ).bind(deviceId, user.id, 'Web (QR)', 'web').run();
  await env.KV.put(
    `session:${webSessionToken}`,
    JSON.stringify({ userId: user.id, deviceId, expiresAt }),
    { expirationTtl: 86400 * 7 }, // 7 days
  );

  // Update QR entry with authorized data
  await env.KV.put(
    `qr:${body.qr_token}`,
    JSON.stringify({
      status: 'authorized',
      session_token: webSessionToken,
      user_id: user.id,
      encrypted_keys: user.identity_private_encrypted,
      identity_key: user.identity_key,
    }),
    { expirationTtl: 60 }, // 1 minute to be picked up
  );

  return jsonResponse({ ok: true });
}
