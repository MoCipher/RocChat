/**
 * RocChat Backend — Middleware
 *
 * Session verification, rate limiting, JSON helpers.
 */

import type { Env } from './index.js';

export interface Session {
  userId: string;
  deviceId: string;
}

/** Verify the session token from the Authorization header */
export async function verifySession(request: Request, env: Env): Promise<Session | null> {
  const auth = request.headers.get('Authorization');
  if (!auth?.startsWith('Bearer ')) return null;

  const token = auth.slice(7);
  if (!token) return null;

  // Look up session in KV
  const sessionData = await env.KV.get(`session:${token}`, 'json');
  if (!sessionData) return null;

  const session = sessionData as { userId: string; deviceId: string; expiresAt: number };
  if (Date.now() / 1000 > session.expiresAt) {
    await env.KV.delete(`session:${token}`);
    return null;
  }

  // Update last active
  await env.DB.prepare('UPDATE devices SET last_active = unixepoch() WHERE id = ?')
    .bind(session.deviceId)
    .run();

  return { userId: session.userId, deviceId: session.deviceId };
}

/** KV-based rate limiter */
export async function rateLimit(
  env: Env,
  userId: string,
  path: string,
): Promise<{ ok: boolean }> {
  // Determine rate limit based on path
  let limit: number;
  let window: number; // seconds

  if (path.startsWith('/api/messages')) {
    limit = 60;
    window = 60;
  } else if (path === '/api/auth/login') {
    limit = 5;
    window = 300; // 5 attempts per 5 minutes
  } else if (path.startsWith('/api/media')) {
    limit = 20;
    window = 3600;
  } else if (path.startsWith('/api/contacts/search')) {
    limit = 10;
    window = 60;
  } else if (path.startsWith('/api/keys')) {
    limit = 30;
    window = 60;
  } else {
    limit = 120;
    window = 60;
  }

  const key = `rl:${userId}:${path.split('/').slice(0, 3).join('/')}`;
  const currentStr = await env.KV.get(key);
  const current = currentStr ? parseInt(currentStr, 10) : 0;

  if (current >= limit) {
    return { ok: false };
  }

  await env.KV.put(key, String(current + 1), { expirationTtl: window });
  return { ok: true };
}

/** Create a JSON response */
export function jsonResponse(data: unknown, status: number = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

/** Create an error response */
export function errorResponse(message: string, status: number): Response {
  return jsonResponse({ error: message }, status);
}

/** Generate a secure random session token */
export function generateSessionToken(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}
