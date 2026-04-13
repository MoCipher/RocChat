/**
 * RocChat Backend — Worker Entrypoint
 *
 * Routes all API requests. Delegates to auth, messages, keys, contacts, media, signaling.
 * Bindings: D1 (DB), R2 (MEDIA), KV (sessions/rate-limits), Durable Objects (CHAT_ROOM).
 */

import { handleAuth } from './auth.js';
import { handleMessages } from './messages.js';
import { handleKeys } from './keys.js';
import { handleContacts } from './contacts.js';
import { handleMedia } from './media.js';
import { handleQrAuth } from './qr-auth.js';
import { handlePush } from './push.js';
import { ChatRoom } from './durable-objects/ChatRoom.js';
import { verifySession, rateLimit, jsonResponse, errorResponse } from './middleware.js';

export { ChatRoom };

export interface Env {
  DB: D1Database;
  MEDIA: R2Bucket;
  KV: KVNamespace;
  CHAT_ROOM: DurableObjectNamespace;
  TURNSTILE_SITE_KEY: string;
  TURNSTILE_SECRET_KEY: string;
  // Push notification secrets (set via `wrangler secret put`)
  APNS_KEY?: string;
  APNS_KEY_ID?: string;
  APNS_TEAM_ID?: string;
  APNS_TOPIC?: string;
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname;

    // Capture request origin for CORS in all responses
    const withCors = (resp: Response) => applyCors(resp, request);

    // CORS headers
    if (request.method === 'OPTIONS') {
      return new Response(null, {
        headers: corsHeaders(request),
      });
    }

    try {
      // ── Public routes (no auth) ──
      if (path === '/api/auth/register' && request.method === 'POST') {
        return withCors(await handleAuth(request, env, 'register'));
      }
      if (path === '/api/auth/login' && request.method === 'POST') {
        // Rate limit login by IP
        const loginIp = request.headers.get('CF-Connecting-IP') || 'unknown';
        const loginRl = await rateLimit(env, `ip:${loginIp}`, '/api/auth/login');
        if (!loginRl.ok) return withCors(errorResponse('Too many login attempts', 429));
        return withCors(await handleAuth(request, env, 'login'));
      }
      if (path === '/api/health') {
        try {
          const dbCheck = await env.DB.prepare('SELECT 1 AS ok').first();
          return withCors(jsonResponse({
            status: dbCheck ? 'ok' : 'degraded',
            service: 'rocchat-api',
            version: '0.2.0',
          }));
        } catch {
          return withCors(jsonResponse({ status: 'degraded', service: 'rocchat-api' }, 503));
        }
      }
      if (path === '/api/config' && request.method === 'GET') {
        return withCors(jsonResponse({
          turnstile_site_key: env.TURNSTILE_SITE_KEY,
        }));
      }

      // QR auth — generate and poll are public, authorize requires auth
      if (path === '/api/auth/qr/generate' && request.method === 'POST') {
        return withCors(await handleQrAuth(request, env, 'generate', url));
      }
      if (path.startsWith('/api/auth/qr/poll/') && request.method === 'GET') {
        return withCors(await handleQrAuth(request, env, 'poll', url));
      }

      // ── Authenticated routes ──
      const session = await verifySession(request, env);
      if (!session) {
        return withCors(errorResponse('Unauthorized', 401));
      }

      // Logout (authenticated)
      if (path === '/api/auth/logout' && request.method === 'POST') {
        const token = request.headers.get('Authorization')?.replace('Bearer ', '');
        if (token) await env.KV.delete(`session:${token}`);
        return withCors(jsonResponse({ ok: true }));
      }

      // Rate limit check
      const rlResult = await rateLimit(env, session.userId, path);
      if (!rlResult.ok) {
        return withCors(errorResponse('Rate limit exceeded', 429));
      }

      // QR authorize (authenticated)
      if (path === '/api/auth/qr/authorize' && request.method === 'POST') {
        return withCors(await handleQrAuth(request, env, 'authorize', url, session));
      }

      // Messages
      if (path.startsWith('/api/messages')) {
        return withCors(await handleMessages(request, env, session, url));
      }

      // Keys (pre-key bundles)
      if (path.startsWith('/api/keys')) {
        return withCors(await handleKeys(request, env, session, url));
      }

      // Contacts & discovery
      if (path.startsWith('/api/contacts')) {
        return withCors(await handleContacts(request, env, session, url));
      }

      // Media upload/download
      if (path.startsWith('/api/media')) {
        return withCors(await handleMedia(request, env, session, url));
      }

      // Push notifications
      if (path.startsWith('/api/push')) {
        return withCors(await handlePush(request, env, session, url));
      }

      // WebSocket upgrade for real-time
      if (path.startsWith('/api/ws/')) {
        const conversationId = path.split('/api/ws/')[1];
        if (!conversationId) {
          return withCors(errorResponse('Missing conversation ID', 400));
        }

        // Verify user is a member of this conversation
        const membership = await env.DB.prepare(
          'SELECT 1 FROM conversation_members WHERE conversation_id = ? AND user_id = ?',
        )
          .bind(conversationId, session.userId)
          .first();

        if (!membership) {
          return withCors(errorResponse('Not a member of this conversation', 403));
        }

        // Route to Durable Object
        const roomId = env.CHAT_ROOM.idFromName(conversationId);
        const room = env.CHAT_ROOM.get(roomId);
        return room.fetch(request);
      }

      // User profile/settings
      if (path === '/api/me' && request.method === 'GET') {
        const user = await env.DB.prepare(
          `SELECT id, username, display_name, identity_key, discoverable,
                  show_read_receipts, show_typing_indicator, show_online_to,
                  who_can_add, default_disappear_timer, created_at
           FROM users WHERE id = ?`,
        )
          .bind(session.userId)
          .first();
        return withCors(jsonResponse(user));
      }

      if (path === '/api/me/settings' && request.method === 'PATCH') {
        const body = await request.json() as Record<string, unknown>;
        const allowed = [
          'display_name', 'discoverable',
          'show_read_receipts', 'show_typing_indicator',
          'show_online_to', 'who_can_add', 'default_disappear_timer',
        ];
        const updates: string[] = [];
        const values: unknown[] = [];

        for (const key of allowed) {
          if (key in body) {
            updates.push(`${key} = ?`);
            values.push(body[key]);
          }
        }

        if (updates.length > 0) {
          values.push(session.userId);
          await env.DB.prepare(`UPDATE users SET ${updates.join(', ')} WHERE id = ?`)
            .bind(...values)
            .run();
        }

        return withCors(jsonResponse({ ok: true }));
      }

      // Devices
      if (path === '/api/devices' && request.method === 'GET') {
        const devices = await env.DB.prepare(
          'SELECT id, device_name, platform, last_active, created_at FROM devices WHERE user_id = ?',
        )
          .bind(session.userId)
          .all();
        return withCors(jsonResponse(devices.results));
      }

      if (path.startsWith('/api/devices/') && request.method === 'DELETE') {
        const deviceId = path.split('/api/devices/')[1];
        await env.DB.prepare('DELETE FROM devices WHERE id = ? AND user_id = ?')
          .bind(deviceId, session.userId)
          .run();
        return withCors(jsonResponse({ ok: true }));
      }

      // Session ping (heartbeat)
      if (path === '/api/ping') {
        return withCors(jsonResponse({ ok: true }));
      }

      return withCors(errorResponse('Not found', 404));
    } catch (err) {
      console.error('Request error:', err);
      return withCors(errorResponse('Internal server error', 500));
    }
  },

  // Scheduled worker for cleanup
  async scheduled(event: ScheduledEvent, env: Env, ctx: ExecutionContext) {
    // Delete expired disappearing messages
    await env.DB.prepare('DELETE FROM messages WHERE expires_at IS NOT NULL AND expires_at < unixepoch()').run();

    // Clean used one-time pre-keys (keep table lean)
    await env.DB.prepare('DELETE FROM one_time_pre_keys WHERE used = 1').run();

    // Clean old rate limit entries (older than 1 hour)
    await env.DB.prepare('DELETE FROM rate_log WHERE ts < unixepoch() - 3600').run();
  },
};

// ── Helpers ──

function corsHeaders(request?: Request): HeadersInit {
  const origin = request?.headers.get('Origin') || '';
  const allowed = ['https://chat.mocipher.com', 'https://rocchat-8x7.pages.dev', 'http://localhost:5173'];
  const allowOrigin = allowed.includes(origin) ? origin : 'https://chat.mocipher.com';
  return {
    'Access-Control-Allow-Origin': allowOrigin,
    'Access-Control-Allow-Methods': 'GET, POST, PUT, PATCH, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Access-Control-Max-Age': '86400',
    'Vary': 'Origin',
  };
}

function applyCors(response: Response, request?: Request): Response {
  const cors = corsHeaders(request);
  const headers = new Headers(response.headers);
  for (const [k, v] of Object.entries(cors)) headers.set(k, v);
  // Security headers
  headers.set('X-Content-Type-Options', 'nosniff');
  headers.set('X-Frame-Options', 'DENY');
  headers.set('Referrer-Policy', 'strict-origin-when-cross-origin');
  headers.set('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  headers.set(
    'Content-Security-Policy',
    "default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; font-src 'self'; connect-src 'self' wss://chat.mocipher.com https://challenges.cloudflare.com; img-src 'self'; frame-src https://challenges.cloudflare.com; frame-ancestors 'none'; base-uri 'none'; form-action 'self';",
  );
  headers.set('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}
