/**
 * RocChat Backend — Authentication
 *
 * Zero-knowledge auth: no email, no phone.
 * Username + passphrase-derived auth hash only.
 */

import type { Env } from './index.js';
import { jsonResponse, errorResponse, generateSessionToken } from './middleware.js';
import { verifyPowSolution } from './pow.js';

export async function handleAuth(
  request: Request,
  env: Env,
  action: 'register' | 'login',
): Promise<Response> {
  if (action === 'register') return handleRegister(request, env);
  return handleLogin(request, env);
}

async function handleRegister(request: Request, env: Env): Promise<Response> {
  // Accept snake_case from web/Android clients
  const raw = await request.json() as Record<string, unknown>;

  const username = raw.username as string | undefined;
  const displayName = (raw.display_name ?? raw.displayName) as string | undefined;
  const authHash = (raw.auth_hash ?? raw.authHash) as string | undefined;
  const salt = raw.salt as string | undefined;
  const encryptedKeys = (raw.encrypted_keys ?? raw.encryptedKeys ?? raw.identity_private_encrypted) as string | undefined;
  const identityKey = (raw.identity_key ?? raw.identityKey) as string | undefined;
  const identityDHKey = (raw.identity_dh_key ?? raw.identityDHKey ?? identityKey) as string | undefined;
  // Turnstile removed — PoW only. No third-party CAPTCHA.
  const powToken = (raw.pow_token ?? raw.powToken) as string | undefined;
  const powNonce = (raw.pow_nonce ?? raw.powNonce) as string | undefined;

  // Signed pre-key: accept nested object OR flat fields
  let spkId = 0;
  let spkPublic: string | undefined;
  let spkSignature: string | undefined;
  const nested = raw.signedPreKey as { id?: number; publicKey?: string; signature?: string } | undefined;
  if (nested?.publicKey) {
    spkId = nested.id ?? 0;
    spkPublic = nested.publicKey;
    spkSignature = nested.signature;
  } else {
    spkPublic = (raw.signed_pre_key_public) as string | undefined;
    spkSignature = (raw.signed_pre_key_signature) as string | undefined;
  }

  // One-time pre-keys: accept [{ id, publicKey }] OR string[]
  let otpKeys: Array<{ id: number; publicKey: string }> = [];
  const rawOtpKeys = (raw.one_time_pre_keys ?? raw.oneTimePreKeys) as unknown;
  if (Array.isArray(rawOtpKeys) && rawOtpKeys.length > 0) {
    if (typeof rawOtpKeys[0] === 'string') {
      otpKeys = (rawOtpKeys as string[]).map((pk, i) => ({ id: i, publicKey: pk }));
    } else {
      otpKeys = rawOtpKeys as Array<{ id: number; publicKey: string }>;
    }
  }

  // Validate required fields
  if (!username || !authHash || !salt || !identityKey || !spkPublic || !otpKeys.length) {
    return errorResponse('Missing required fields', 400);
  }

  // Validate username format: 3-32 chars, alphanumeric + underscore
  const usernameRegex = /^[a-zA-Z][a-zA-Z0-9_]{2,31}$/;
  if (!usernameRegex.test(username)) {
    return errorResponse(
      'Username must be 3-32 characters, start with a letter, and contain only letters, numbers, and underscores',
      400,
    );
  }

  // Proof-of-work anti-bot protection — no third-party CAPTCHA services
  const difficulty = parseInt(env.POW_DIFFICULTY || '18', 10);
  if (difficulty > 0) {
    const ip = request.headers.get('CF-Connecting-IP') || 'unknown';
    if (!powToken || !powNonce) {
      return errorResponse('Proof-of-work required', 403);
    }
    const powOk = await verifyPowSolution(env, powToken, powNonce, ip);
    if (!powOk) {
      return errorResponse('Invalid proof-of-work', 403);
    }
  }

  // Rate limit signups by IP
  const ip = request.headers.get('CF-Connecting-IP') || 'unknown';
  const signupKey = `rl:signup:${ip}`;
  const signupCountStr = await env.KV.get(signupKey);
  const signupCount = signupCountStr ? parseInt(signupCountStr, 10) : 0;
  if (signupCount >= 5) {
    return errorResponse('Too many signups from this location', 429);
  }
  await env.KV.put(signupKey, String(signupCount + 1), { expirationTtl: 3600 });

  // Check username availability
  const existing = await env.DB.prepare('SELECT 1 FROM users WHERE username = ?')
    .bind(username.toLowerCase())
    .first();
  if (existing) {
    return errorResponse('Username already taken', 409);
  }

  // Generate user ID
  const userId = crypto.randomUUID();
  const deviceId = crypto.randomUUID();
  const now = Math.floor(Date.now() / 1000);

  // Insert user
  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO users (id, username, display_name, auth_hash, salt, encrypted_keys, identity_key, identity_dh_key, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).bind(
      userId,
      username.toLowerCase(),
      displayName || username,
      authHash,
      salt,
      encryptedKeys || '',
      identityKey,
      identityDHKey || identityKey,
      now,
    ),

    // Insert signed pre-key
    env.DB.prepare(
      `INSERT INTO signed_pre_keys (id, user_id, public_key, signature, created_at)
       VALUES (?, ?, ?, ?, ?)`,
    ).bind(spkId, userId, spkPublic, spkSignature || '', now),

    // Insert device
    env.DB.prepare(
      `INSERT INTO devices (id, user_id, device_name, platform, created_at, last_active)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).bind(deviceId, userId, 'First device', 'web', now, now),
  ]);

  // Insert one-time pre-keys
  const opkStatements = otpKeys.map((opk) =>
    env.DB.prepare(
      `INSERT INTO one_time_pre_keys (id, user_id, public_key) VALUES (?, ?, ?)`,
    ).bind(opk.id, userId, opk.publicKey),
  );
  if (opkStatements.length > 0) {
    await env.DB.batch(opkStatements);
  }

  // Create session
  const sessionToken = generateSessionToken();
  const sessionExpiry = now + 30 * 24 * 3600; // 30 days
  await env.KV.put(
    `session:${sessionToken}`,
    JSON.stringify({ userId, deviceId, expiresAt: sessionExpiry }),
    { expirationTtl: 30 * 24 * 3600 },
  );

  return jsonResponse(
    {
      user_id: userId,
      session_token: sessionToken,
      device_id: deviceId,
    },
    201,
  );
}

async function handleLogin(request: Request, env: Env): Promise<Response> {
  const raw = await request.json() as Record<string, unknown>;

  const username = raw.username as string | undefined;
  const authHash = (raw.auth_hash ?? raw.authHash) as string | undefined;
  const deviceName = (raw.device_name ?? raw.deviceName) as string | undefined;
  const platform = raw.platform as string | undefined;
  const powToken = (raw.pow_token ?? raw.powToken) as string | undefined;
  const powNonce = (raw.pow_nonce ?? raw.powNonce) as string | undefined;

  if (!username || !authHash) {
    return errorResponse('Missing username or passphrase', 400);
  }

  const difficulty = parseInt(env.POW_DIFFICULTY || '0', 10) || 0;
  if (difficulty > 0) {
    const ip = request.headers.get('CF-Connecting-IP') || 'unknown';
    if (!powToken || !powNonce) {
      return errorResponse('Proof-of-work required', 403);
    }
    const powOk = await verifyPowSolution(env, powToken, powNonce, ip);
    if (!powOk) {
      return errorResponse('Invalid proof-of-work', 403);
    }
  }

  // Constant-time-ish lookup (always query to prevent timing attacks)
  const user = await env.DB.prepare(
    'SELECT id, auth_hash, salt, encrypted_keys, identity_key FROM users WHERE username = ?',
  )
    .bind(username.toLowerCase())
    .first<{ id: string; auth_hash: string; salt: string; encrypted_keys: string; identity_key: string }>();

  if (!user) {
    // Simulate work to prevent timing-based user enumeration
    await new Promise((r) => setTimeout(r, 100 + Math.random() * 50));
    return errorResponse('Invalid credentials', 401);
  }

  // Compare auth hash (constant-time comparison)
  if (!timingSafeEqual(user.auth_hash, authHash)) {
    return errorResponse('Invalid credentials', 401);
  }

  // Create device entry
  const deviceId = crypto.randomUUID();
  const now = Math.floor(Date.now() / 1000);
  await env.DB.prepare(
    `INSERT INTO devices (id, user_id, device_name, platform, created_at, last_active)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).bind(
    deviceId,
    user.id,
    deviceName || 'Unknown device',
    platform || 'web',
    now,
    now,
  ).run();

  // Create session
  const sessionToken = generateSessionToken();
  const sessionExpiry = now + 30 * 24 * 3600;
  await env.KV.put(
    `session:${sessionToken}`,
    JSON.stringify({ userId: user.id, deviceId, expiresAt: sessionExpiry }),
    { expirationTtl: 30 * 24 * 3600 },
  );

  // Fetch signed pre-key public for client-side caching
  const spk = await env.DB.prepare(
    'SELECT public_key FROM signed_pre_keys WHERE user_id = ? ORDER BY created_at DESC LIMIT 1',
  ).bind(user.id).first<{ public_key: string }>();

  return jsonResponse({
    user_id: user.id,
    session_token: sessionToken,
    device_id: deviceId,
    encrypted_keys: user.encrypted_keys,
    identity_key: user.identity_key,
    salt: user.salt,
    signed_pre_key_public: spk?.public_key || null,
  });
}

// Turnstile removed — RocChat uses proof-of-work only. No third-party CAPTCHA.

/** Constant-time string comparison using Web Crypto */
function timingSafeEqual(a: string, b: string): boolean {
  const encoder = new TextEncoder();
  const aBuf = encoder.encode(a);
  const bBuf = encoder.encode(b);
  if (aBuf.length !== bBuf.length) {
    // Compare against self to consume same time, then return false
    const dummy = new Uint8Array(aBuf.length);
    let diff = 1; // force false due to length mismatch
    for (let i = 0; i < aBuf.length; i++) {
      diff |= aBuf[i] ^ dummy[i];
    }
    return false;
  }
  let diff = 0;
  for (let i = 0; i < aBuf.length; i++) {
    diff |= aBuf[i] ^ bBuf[i];
  }
  return diff === 0;
}
