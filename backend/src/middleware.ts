/**
 * RocChat Backend — Middleware
 */

import type { Env } from './index.js';

export interface Session {
  userId: string;
  deviceId: string;
}

export async function verifySession(request: Request, env: Env): Promise<Session | null> {
  const auth = request.headers.get('Authorization');
  if (!auth?.startsWith('Bearer ')) return null;
  const token = auth.slice(7);
  if (!token) return null;
  const sessionData = await env.KV.get(`session:${token}`, 'json');
  if (!sessionData) return null;
  const session = sessionData as { userId: string; deviceId: string; expiresAt: number };
  if (Date.now() / 1000 > session.expiresAt) {
    await env.KV.delete(`session:${token}`);
    return null;
  }
  await env.DB.prepare('UPDATE devices SET last_active = unixepoch() WHERE id = ?')
    .bind(session.deviceId).run();
  return { userId: session.userId, deviceId: session.deviceId };
}

const ALLOWED_ORIGINS = new Set([
  'https://chat.mocipher.com',
  'https://rocchat-8x7.pages.dev',
  'http://localhost:5173',
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

export async function rateLimit(
  env: Env,
  userId: string,
  path: string,
): Promise<{ ok: boolean }> {
  let limit: number;
  let window: number;
  let bucket: string;
  if (path.startsWith('/api/messages')) { limit = 60; window = 60; bucket = '/api/messages'; }
  else if (path === '/api/auth/login') { limit = 5; window = 300; bucket = '/api/auth/login'; }
  else if (path === '/api/auth/refresh') { limit = 30; window = 300; bucket = '/api/auth/refresh'; }
  // Recovery vault: tight bucket. Anyone with a stolen session token still
  // can't brute-force the BIP39 mnemonic against the encrypted blob, but we
  // make the abuse pattern (mass downloading vaults across leaked sessions)
  // expensive and observable.
  else if (path === '/api/recovery/vault') { limit = 10; window = 3600; bucket = '/api/recovery/vault'; }
  else if (path.startsWith('/api/media')) { limit = 20; window = 3600; bucket = '/api/media'; }
  else if (path.startsWith('/api/contacts/search')) { limit = 10; window = 60; bucket = '/api/contacts/search'; }
  else if (path.startsWith('/api/keys')) { limit = 30; window = 60; bucket = '/api/keys'; }
  else if (path.startsWith('/api/groups')) {
    // Separate buckets for sensitive admin actions vs read operations
    const action = path.split('/')[4] || 'default'; // e.g. promote, kick, mute, members
    limit = 30; window = 60; bucket = `/api/groups/:id/${action}`;
  }
  else { limit = 120; window = 60; bucket = path.split('/').slice(0, 4).join('/'); }
  const key = `rl:${userId}:${bucket}`;
  const now = Date.now();
  const windowMs = window * 1000;
  const raw = await env.KV.get(key);
  const timestamps: number[] = raw ? JSON.parse(raw) : [];
  // Prune entries outside the window
  const valid = timestamps.filter(t => now - t < windowMs);
  if (valid.length >= limit) return { ok: false };
  valid.push(now);
  await env.KV.put(key, JSON.stringify(valid), { expirationTtl: window });
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
