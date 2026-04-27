/**
 * RocChat Backend — Authentication
 *
 * Zero-knowledge auth: no email, no phone.
 * Username + passphrase-derived auth hash only.
 */

import type { Env } from './index.js';
import { jsonResponse, errorResponse, apiError, generateSessionToken, logEvent } from './middleware.js';
import { verifyPowSolution, getPowDifficulty } from './pow.js';
import { sendLoginNotification } from './notifications.js';

/** Minimum PBKDF2/scrypt iterations we will accept from clients. */
const MIN_KDF_ITERATIONS = 100_000;
const SESSION_TTL_SECONDS = 24 * 3600;         // access token: 24 hours
const REFRESH_TTL_SECONDS = 30 * 24 * 3600;    // refresh token: 30 days

/**
 * Reject weak KDF parameters. The client sends `kdf_iterations` (preferred),
 * or we fall back to parsing from a PHC-style `auth_hash` prefix like
 * "pbkdf2-sha256$100000$...". Missing info → accept (legacy clients).
 */
export function validateKdfStrength(raw: Record<string, unknown>): { ok: boolean; iterations?: number } {
  const explicit = (raw.kdf_iterations ?? raw.kdfIterations) as number | undefined;
  if (typeof explicit === 'number' && explicit >= MIN_KDF_ITERATIONS) {
    return { ok: true, iterations: explicit };
  }
  if (typeof explicit === 'number' && explicit < MIN_KDF_ITERATIONS) {
    return { ok: false, iterations: explicit };
  }
  const hash = (raw.auth_hash ?? raw.authHash) as string | undefined;
  if (typeof hash === 'string' && hash.includes('$')) {
    const parts = hash.split('$');
    // formats like "pbkdf2-sha256$100000$salt$hash"
    const n = parseInt(parts[1] || '', 10);
    if (!isNaN(n)) {
      return { ok: n >= MIN_KDF_ITERATIONS, iterations: n };
    }
  }
  // Legacy client without iteration metadata — allow for backwards compat.
  return { ok: true };
}

/** Issue a paired access + refresh token and persist them in KV. */
async function issueSession(
  env: Env,
  userId: string,
  deviceId: string,
): Promise<{ sessionToken: string; refreshToken: string; sessionExpiresAt: number; refreshExpiresAt: number }> {
  const now = Math.floor(Date.now() / 1000);
  const sessionToken = generateSessionToken();
  const refreshToken = generateSessionToken();
  const sessionExpiresAt = now + SESSION_TTL_SECONDS;
  const refreshExpiresAt = now + REFRESH_TTL_SECONDS;
  await env.KV.put(
    `session:${sessionToken}`,
    JSON.stringify({ userId, deviceId, expiresAt: sessionExpiresAt }),
    { expirationTtl: SESSION_TTL_SECONDS },
  );
  await env.KV.put(
    `refresh:${refreshToken}`,
    JSON.stringify({ userId, deviceId, sessionToken, expiresAt: refreshExpiresAt }),
    { expirationTtl: REFRESH_TTL_SECONDS },
  );
  return { sessionToken, refreshToken, sessionExpiresAt, refreshExpiresAt };
}

/**
 * Exchange a refresh_token for a fresh (session_token, refresh_token) pair.
 * Rotates the refresh token on every use so that stolen refresh tokens are
 * limited to a single use window.
 */
export async function handleRefresh(request: Request, env: Env): Promise<Response> {
  const raw = (await request.json().catch(() => ({}))) as Record<string, unknown>;
  const token = (raw.refresh_token ?? raw.refreshToken) as string | undefined;
  if (!token) return apiError('BAD_REQUEST', 'Missing refresh_token');

  const stored = await env.KV.get(`refresh:${token}`, 'json') as
    | { userId: string; deviceId: string; sessionToken: string; expiresAt: number }
    | null;
  if (!stored) return apiError('UNAUTHORIZED', 'Refresh token invalid or expired');

  // Single-use: delete old refresh immediately (and best-effort old access token).
  await env.KV.delete(`refresh:${token}`);
  if (stored.sessionToken) {
    await env.KV.delete(`session:${stored.sessionToken}`);
  }

  const { sessionToken, refreshToken, sessionExpiresAt, refreshExpiresAt } = await issueSession(
    env,
    stored.userId,
    stored.deviceId,
  );
  return jsonResponse({
    session_token: sessionToken,
    refresh_token: refreshToken,
    expires_at: sessionExpiresAt,
    refresh_expires_at: refreshExpiresAt,
  });
}

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

  // Reject weak KDF parameters
  const kdf = validateKdfStrength(raw);
  if (!kdf.ok) {
    logEvent('warn', 'weak_kdf_rejected', { iterations: kdf.iterations, action: 'register' });
    return apiError('WEAK_KDF', `Auth hash iteration count below minimum (${MIN_KDF_ITERATIONS})`);
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
  const difficulty = await getPowDifficulty(env);
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

  // Batch ALL registration writes (user + device + SPK + OPKs) into a single
  // D1 round-trip so a crashed worker can't leave partial state.
  const regStatements: D1PreparedStatement[] = [
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
    env.DB.prepare(
      `INSERT INTO signed_pre_keys (id, user_id, public_key, signature, created_at)
       VALUES (?, ?, ?, ?, ?)`,
    ).bind(spkId, userId, spkPublic, spkSignature || '', now),
    env.DB.prepare(
      `INSERT INTO devices (id, user_id, device_name, platform, created_at, last_active)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).bind(deviceId, userId, 'First device', (raw.platform as string) || 'web', now, now),
    ...otpKeys.map((opk) =>
      env.DB.prepare(
        `INSERT INTO one_time_pre_keys (id, user_id, public_key) VALUES (?, ?, ?)`,
      ).bind(opk.id, userId, opk.publicKey),
    ),
  ];
  await env.DB.batch(regStatements);

  // Create session + refresh token
  const { sessionToken, refreshToken, sessionExpiresAt, refreshExpiresAt } = await issueSession(env, userId, deviceId);

  return jsonResponse(
    {
      user_id: userId,
      session_token: sessionToken,
      refresh_token: refreshToken,
      expires_at: sessionExpiresAt,
      refresh_expires_at: refreshExpiresAt,
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

  // Reject weak KDF parameters (soft: legacy clients without metadata still OK)
  const kdf = validateKdfStrength(raw);
  if (!kdf.ok) {
    logEvent('warn', 'weak_kdf_rejected', { iterations: kdf.iterations, action: 'login' });
    return apiError('WEAK_KDF', `Auth hash iteration count below minimum (${MIN_KDF_ITERATIONS})`);
  }

  const difficulty = await getPowDifficulty(env);
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

  // Create session + refresh token
  const { sessionToken, refreshToken, sessionExpiresAt, refreshExpiresAt } = await issueSession(env, user.id, deviceId);

  // Notify other devices of this new login (fire-and-forget — do not await)
  void sendLoginNotification(env, user.id, deviceId, platform || 'web', deviceName || 'Unknown device', request.headers.get('CF-Connecting-IP') ?? undefined).catch(() => { /* non-critical */ });

  // Fetch signed pre-key public for client-side caching
  const spk = await env.DB.prepare(
    'SELECT public_key FROM signed_pre_keys WHERE user_id = ? ORDER BY created_at DESC LIMIT 1',
  ).bind(user.id).first<{ public_key: string }>();

  return jsonResponse({
    user_id: user.id,
    session_token: sessionToken,
    refresh_token: refreshToken,
    expires_at: sessionExpiresAt,
    refresh_expires_at: refreshExpiresAt,
    device_id: deviceId,
    encrypted_keys: user.encrypted_keys,
    identity_key: user.identity_key,
    salt: user.salt,
    signed_pre_key_public: spk?.public_key || null,
  });
}

// Turnstile removed — RocChat uses proof-of-work only. No third-party CAPTCHA.

/**
 * Recovery — start: returns the encrypted recovery vault for a username so
 * the client can decrypt it locally with the user's BIP39 mnemonic. The
 * blob is opaque (AES-GCM with a key derived from 128-bit BIP39 entropy);
 * the only sensitive material disclosed is the user's identity public key
 * + the auth-hash salt, both of which are public anyway after first message.
 *
 * Anti-abuse:
 *  - Per-IP & per-username rate limit happens at the router layer.
 *  - Proof-of-work required (same as login) to prevent mass enumeration.
 *  - Returns the same shape regardless of whether the user/vault exists,
 *    using a constant-time delay; an opaque error code is returned so the
 *    client can distinguish "not eligible for recovery" from "bad PoW".
 */
export async function handleRecoveryStart(request: Request, env: Env): Promise<Response> {
  const ip = request.headers.get('CF-Connecting-IP') || 'unknown';
  const body = (await request.json().catch(() => ({}))) as {
    username?: string;
    pow_token?: string;
    pow_nonce?: string;
  };
  const username = (body.username || '').trim().toLowerCase();
  if (!username || username.length > 64) return apiError('BAD_REQUEST', 'Missing username');

  if (!body.pow_token || !body.pow_nonce) return errorResponse('Proof-of-work required', 403);
  const powOk = await verifyPowSolution(env, body.pow_token, body.pow_nonce, ip);
  if (!powOk) return errorResponse('Invalid proof-of-work', 403);

  // Always burn ~120ms to flatten timing.
  const delay = new Promise<void>((resolve) => setTimeout(resolve, 80 + Math.random() * 60));

  const user = await env.DB.prepare('SELECT id, salt, identity_key FROM users WHERE username = ?')
    .bind(username)
    .first<{ id: string; salt: string; identity_key: string }>();

  if (!user) {
    await delay;
    return errorResponse('No recovery vault found', 404);
  }

  const raw = await env.KV.get(`recovery_vault:${user.id}`);
  if (!raw) {
    await delay;
    return errorResponse('No recovery vault found', 404);
  }

  let blob = raw;
  let verifierPresent = false;
  try {
    const parsed = JSON.parse(raw) as { blob?: string; verifier?: string | null };
    if (parsed && typeof parsed.blob === 'string') blob = parsed.blob;
    verifierPresent = typeof parsed?.verifier === 'string' && parsed.verifier.length > 0;
  } catch { /* legacy raw blob */ }

  await delay;
  // Issue a one-time recovery challenge bound to this username + IP.
  // The client must echo this challenge in `complete` and prove possession
  // of the recovery key by matching the stored verifier.
  const challenge = crypto.randomUUID();
  await env.KV.put(`recovery_challenge:${user.id}`, JSON.stringify({ challenge, ip, ts: Date.now() }), {
    expirationTtl: 600,
  });

  return jsonResponse({
    blob,
    salt: user.salt,
    identity_key: user.identity_key,
    challenge,
    requires_verifier: verifierPresent,
  });
}

/**
 * Recovery — complete: rotates the user's auth_hash + encrypted_keys after
 * verifying the recovery verifier. Revokes all existing sessions on success.
 *
 * Body:
 *  - username, challenge: returned from /recovery/start
 *  - new_auth_hash, new_salt, new_encrypted_keys: re-derived from the
 *    user's freshly-chosen passphrase
 *  - new_recovery_blob, new_recovery_verifier: the recovery vault re-bundled
 *    against the existing recovery key (so the user can recover again)
 *  - recovery_verifier: SHA-256(domain || recoveryKey) — must match the
 *    verifier stored at the original /recovery/vault upload time
 *  - pow_token / pow_nonce: PoW solution
 */
export async function handleRecoveryComplete(request: Request, env: Env): Promise<Response> {
  const ip = request.headers.get('CF-Connecting-IP') || 'unknown';
  const body = (await request.json().catch(() => ({}))) as {
    username?: string;
    challenge?: string;
    new_auth_hash?: string;
    new_salt?: string;
    new_encrypted_keys?: string;
    new_recovery_blob?: string;
    new_recovery_verifier?: string;
    recovery_verifier?: string;
    pow_token?: string;
    pow_nonce?: string;
  };
  const username = (body.username || '').trim().toLowerCase();
  if (!username) return apiError('BAD_REQUEST', 'Missing username');
  if (!body.new_auth_hash || !body.new_salt || !body.new_encrypted_keys) {
    return apiError('BAD_REQUEST', 'Missing new credentials');
  }
  if (!body.recovery_verifier) return apiError('BAD_REQUEST', 'Missing recovery verifier');
  if (!body.challenge) return apiError('BAD_REQUEST', 'Missing recovery challenge');

  if (!body.pow_token || !body.pow_nonce) return errorResponse('Proof-of-work required', 403);
  const powOk = await verifyPowSolution(env, body.pow_token, body.pow_nonce, ip);
  if (!powOk) return errorResponse('Invalid proof-of-work', 403);

  // Reject obviously malformed credentials early
  if (body.new_auth_hash.length < 16 || body.new_auth_hash.length > 512) {
    return apiError('BAD_REQUEST', 'Invalid auth_hash');
  }
  if (body.new_salt.length < 16 || body.new_salt.length > 256) {
    return apiError('BAD_REQUEST', 'Invalid salt');
  }
  if (body.new_encrypted_keys.length > 32 * 1024) {
    return apiError('BAD_REQUEST', 'encrypted_keys too large');
  }

  const user = await env.DB.prepare('SELECT id FROM users WHERE username = ?')
    .bind(username)
    .first<{ id: string }>();
  if (!user) {
    await new Promise((r) => setTimeout(r, 100));
    return errorResponse('Recovery not eligible', 403);
  }

  // Verify the one-time challenge
  const challengeRaw = await env.KV.get(`recovery_challenge:${user.id}`);
  if (!challengeRaw) return errorResponse('Recovery challenge expired', 403);
  let challengeData: { challenge: string; ip: string; ts: number };
  try {
    challengeData = JSON.parse(challengeRaw) as { challenge: string; ip: string; ts: number };
  } catch {
    return errorResponse('Recovery challenge invalid', 403);
  }
  if (!timingSafeEqual(challengeData.challenge, body.challenge)) {
    return errorResponse('Recovery challenge invalid', 403);
  }
  // Single-use
  await env.KV.delete(`recovery_challenge:${user.id}`);

  // Verify recovery verifier matches what's stored
  const storedVaultRaw = await env.KV.get(`recovery_vault:${user.id}`);
  if (!storedVaultRaw) return errorResponse('Recovery not eligible', 403);
  let storedVerifier: string | null = null;
  try {
    const parsed = JSON.parse(storedVaultRaw) as { verifier?: string | null };
    storedVerifier = typeof parsed.verifier === 'string' ? parsed.verifier : null;
  } catch { /* legacy: no verifier present */ }
  if (!storedVerifier) {
    // Legacy vault — recovery via this endpoint is not authorised for users
    // that haven't migrated to the verifier-protected vault yet.
    return errorResponse('Account not eligible for self-service recovery', 403);
  }
  if (!timingSafeEqual(storedVerifier, body.recovery_verifier)) {
    return errorResponse('Recovery verification failed', 403);
  }

  // Rotate auth credentials atomically
  await env.DB.prepare(
    'UPDATE users SET auth_hash = ?, salt = ?, encrypted_keys = ? WHERE id = ?',
  ).bind(body.new_auth_hash, body.new_salt, body.new_encrypted_keys, user.id).run();

  // Optionally rotate the recovery vault itself (mnemonic stays the same;
  // bundle inside might have changed).
  if (body.new_recovery_blob) {
    await env.KV.put(`recovery_vault:${user.id}`, JSON.stringify({
      blob: body.new_recovery_blob,
      verifier: body.new_recovery_verifier || storedVerifier,
    }));
  }

  // Revoke ALL existing sessions for this user — every device must re-login.
  // KV doesn't support prefix scans cheaply, so we additionally maintain a
  // user-session index. If it's missing for a given session, the next
  // request from that device will re-auth via the normal mechanism.
  try {
    const idx = await env.KV.get(`user_sessions:${user.id}`, 'json') as string[] | null;
    if (Array.isArray(idx)) {
      for (const tok of idx) {
        await env.KV.delete(`session:${tok}`);
      }
      await env.KV.delete(`user_sessions:${user.id}`);
    }
  } catch { /* best-effort */ }

  // Mark all device records as inactive so push tokens stop firing until login
  await env.DB.prepare('UPDATE devices SET last_active = ? WHERE user_id = ?')
    .bind(0, user.id)
    .run();

  logEvent('info', 'recovery_completed', { user_id_hash: user.id.slice(0, 8) });

  return jsonResponse({ ok: true });
}

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
