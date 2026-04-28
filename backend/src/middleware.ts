/**
 * RocChat Backend — Middleware
 */

import type { Env } from './index.js';

export interface Session {
  userId: string;
  deviceId: string;
}

// ── In-memory session cache (per-isolate, avoids KV reads) ──────────
const sessionCache = new Map<string, { session: Session; expiresAt: number; cachedAt: number }>();
const SESSION_CACHE_TTL = 120_000; // 2 minutes
const SESSION_CACHE_MAX = 500;

async function hashToken(token: string): Promise<string> {
  const data = new TextEncoder().encode(token);
  const digest = await crypto.subtle.digest('SHA-256', data);
  return Array.from(new Uint8Array(digest)).map((b) => b.toString(16).padStart(2, '0')).join('');
}

export async function verifySession(request: Request, env: Env): Promise<Session | null> {
  const auth = request.headers.get('Authorization');
  if (!auth?.startsWith('Bearer ')) return null;
  const token = auth.slice(7);
  if (!token) return null;

  // Check in-memory cache first
  const now = Date.now();
  const cached = sessionCache.get(token);
  if (cached && now - cached.cachedAt < SESSION_CACHE_TTL && now / 1000 <= cached.expiresAt) {
    return cached.session;
  }

  const tokenHash = await hashToken(token);
  const sessionData = await env.KV.get(`sessionh:${tokenHash}`, 'json')
    || await env.KV.get(`session:${token}`, 'json');
  if (!sessionData) {
    sessionCache.delete(token);
    return null;
  }
  const session = sessionData as { userId: string; deviceId: string; expiresAt: number };
  if (Date.now() / 1000 > session.expiresAt) {
    sessionCache.delete(token);
    await env.KV.delete(`sessionh:${tokenHash}`);
    await env.KV.delete(`session:${token}`);
    return null;
  }

  const result = { userId: session.userId, deviceId: session.deviceId };

  // Populate cache (evict oldest if full)
  if (sessionCache.size >= SESSION_CACHE_MAX) {
    const oldest = sessionCache.keys().next().value;
    if (oldest) sessionCache.delete(oldest);
  }
  sessionCache.set(token, { session: result, expiresAt: session.expiresAt, cachedAt: now });

  // Fire-and-forget last_active update — don't block the response
  env.DB.prepare('UPDATE devices SET last_active = unixepoch() WHERE id = ?')
    .bind(session.deviceId).run().catch(() => {});
  return result;
}

const ALLOWED_ORIGINS = new Set([
  'https://chat.mocipher.com',
  'https://rocchat-8x7.pages.dev',
  'http://localhost:5173',
  'tauri://localhost',
  'https://tauri.localhost',
]);

export function isOriginAllowed(request: Request): boolean {
  const method = request.method.toUpperCase();
  if (method === 'GET' || method === 'HEAD' || method === 'OPTIONS') return true;
  const origin = request.headers.get('Origin');
  if (!origin) {
    const referer = request.headers.get('Referer');
    return !referer;
  }
  return ALLOWED_ORIGINS.has(origin);
}

// ── In-memory rate limiter (per-isolate, eliminates 2 KV ops/request) ─
const rateLimitMap = new Map<string, number[]>();
const RATE_LIMIT_MAP_MAX = 2000;
let lastRateLimitPrune = Date.now();

export async function rateLimit(
  env: Env,
  userId: string,
  path: string,
): Promise<{ ok: boolean; retryAfter?: number }> {
  let limit: number;
  let window: number;
  let bucket: string;
  if (path.startsWith('/api/messages')) { limit = 60; window = 60; bucket = '/api/messages'; }
  else if (path === '/api/auth/login') { limit = 5; window = 300; bucket = '/api/auth/login'; }
  else if (path === '/api/auth/login/user') { limit = 5; window = 300; bucket = '/api/auth/login/user'; }
  else if (path === '/api/auth/refresh') { limit = 30; window = 300; bucket = '/api/auth/refresh'; }
  else if (path === '/api/recovery/vault') { limit = 10; window = 3600; bucket = '/api/recovery/vault'; }
  else if (path === '/api/recovery/start') { limit = 5; window = 600; bucket = '/api/recovery/start'; }
  else if (path === '/api/recovery/start/user') { limit = 5; window = 1800; bucket = '/api/recovery/start/user'; }
  else if (path === '/api/recovery/complete') { limit = 5; window = 600; bucket = '/api/recovery/complete'; }
  else if (path.startsWith('/api/media')) { limit = 20; window = 3600; bucket = '/api/media'; }
  else if (path.startsWith('/api/contacts/search')) { limit = 10; window = 60; bucket = '/api/contacts/search'; }
  else if (path === '/api/ws/ticket') { limit = 30; window = 60; bucket = '/api/ws/ticket'; }
  else if (path.startsWith('/api/keys')) { limit = 30; window = 60; bucket = '/api/keys'; }
  else if (path.startsWith('/api/groups')) {
    const action = path.split('/')[4] || 'default';
    limit = 30; window = 60; bucket = `/api/groups/:id/${action}`;
  }
  else { limit = 120; window = 60; bucket = path.split('/').slice(0, 4).join('/'); }

  const key = `${userId}:${bucket}`;
  const now = Date.now();
  const windowMs = window * 1000;

  // Distributed limiter via KV (shared across isolates/instances).
  const kvKey = `rl2:${key}`;
  try {
    const existing = await env.KV.get(kvKey, 'json') as number[] | null;
    const raw = Array.isArray(existing) ? existing : [];
    const valid = raw.filter((ts) => now - ts < windowMs);
    if (valid.length >= limit) {
      return { ok: false, retryAfter: Math.ceil((valid[0] + windowMs - now) / 1000) };
    }
    valid.push(now);
    await env.KV.put(kvKey, JSON.stringify(valid), { expirationTtl: Math.max(window + 5, 30) });
    return { ok: true };
  } catch {
    // Fall back to in-isolate map if KV read/write fails.
  }

  // Periodic prune to prevent unbounded growth
  if (now - lastRateLimitPrune > 30_000) {
    lastRateLimitPrune = now;
    for (const [k, ts] of rateLimitMap) {
      if (!ts.length || now - ts[ts.length - 1] > 3600_000) rateLimitMap.delete(k);
    }
  }
  // Evict oldest entries if map is too large
  if (rateLimitMap.size >= RATE_LIMIT_MAP_MAX) {
    const oldest = rateLimitMap.keys().next().value;
    if (oldest) rateLimitMap.delete(oldest);
  }

  const timestamps = rateLimitMap.get(key) ?? [];
  // Prune entries outside the window
  let start = 0;
  while (start < timestamps.length && now - timestamps[start] >= windowMs) start++;
  const valid = start > 0 ? timestamps.slice(start) : timestamps;
  if (valid.length >= limit) {
    return { ok: false, retryAfter: Math.ceil((valid[0] + windowMs - now) / 1000) };
  }
  valid.push(now);
  rateLimitMap.set(key, valid);
  return { ok: true };
}

export function jsonResponse(data: unknown, status: number = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

export type ErrorCode =
  | 'BAD_REQUEST' | 'UNAUTHORIZED' | 'FORBIDDEN' | 'CSRF_BLOCKED'
  | 'NOT_FOUND' | 'CONFLICT' | 'PAYLOAD_TOO_LARGE' | 'UNSUPPORTED_MEDIA'
  | 'RATE_LIMITED' | 'BANNED' | 'POW_REQUIRED' | 'POW_INVALID'
  | 'WEAK_KDF' | 'INTERNAL';

const DEFAULT_STATUS: Record<ErrorCode, number> = {
  BAD_REQUEST: 400, UNAUTHORIZED: 401, FORBIDDEN: 403, CSRF_BLOCKED: 403,
  NOT_FOUND: 404, CONFLICT: 409, PAYLOAD_TOO_LARGE: 413, UNSUPPORTED_MEDIA: 415,
  RATE_LIMITED: 429, BANNED: 451, POW_REQUIRED: 403, POW_INVALID: 403,
  WEAK_KDF: 400, INTERNAL: 500,
};

export function apiError(code: ErrorCode, message: string, status?: number): Response {
  return jsonResponse({ error: message, code }, status ?? DEFAULT_STATUS[code]);
}

export function errorResponse(message: string, status: number): Response {
  const code: ErrorCode =
    status === 400 ? 'BAD_REQUEST' :
    status === 401 ? 'UNAUTHORIZED' :
    status === 403 ? 'FORBIDDEN' :
    status === 404 ? 'NOT_FOUND' :
    status === 409 ? 'CONFLICT' :
    status === 413 ? 'PAYLOAD_TOO_LARGE' :
    status === 415 ? 'UNSUPPORTED_MEDIA' :
    status === 429 ? 'RATE_LIMITED' :
    status === 451 ? 'BANNED' : 'INTERNAL';
  return jsonResponse({ error: message, code }, status);
}

export function generateSessionToken(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

export function logEvent(
  level: 'info' | 'warn' | 'error',
  event: string,
  fields: Record<string, unknown> = {},
): void {
  try {
    console.log(JSON.stringify({ level, event, ts: Date.now(), ...fields }));
  } catch {
    console.log(level, event, fields);
  }
}
