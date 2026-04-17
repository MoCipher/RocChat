/**
 * RocChat Backend — Worker Entrypoint
 *
 * Routes all API requests. Delegates to auth, messages, keys, contacts, media, signaling.
 * Bindings: D1 (DB), R2 (MEDIA), KV (sessions/rate-limits), Durable Objects (CHAT_ROOM).
 */

import { handleAuth } from './auth.js';
import { handleRefresh } from './auth.js';
import { handleMessages } from './messages.js';
import { handleKeys } from './keys.js';
import { handleContacts } from './contacts.js';
import { handleMedia } from './media.js';
import { handleQrAuth } from './qr-auth.js';
import { handlePush } from './push.js';
import { handleBusiness } from './business.js';
import { handleFeatures } from './features.js';
import { handleLinkPreview } from './link-preview.js';
import { handleGroups } from './groups.js';
import { createPowChallenge } from './pow.js';
import { ChatRoom } from './durable-objects/ChatRoom.js';
import { verifySession, rateLimit, jsonResponse, errorResponse, isOriginAllowed, apiError, logEvent } from './middleware.js';
import type { Session } from './middleware.js';

export { ChatRoom };

export interface Env {
  DB: D1Database;
  MEDIA: R2Bucket;
  KV: KVNamespace;
  CHAT_ROOM: DurableObjectNamespace;
  TURN_SECRET?: string;
  TURN_SERVER?: string;
  POW_DIFFICULTY?: string;
  NTFY_URL?: string;
  CRYPTO_WALLET_ADDRESS?: string;
  CRYPTO_USDC_RATE?: string;
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

    // CSRF defense-in-depth: reject state-changing requests from unknown origins.
    // GET/HEAD/OPTIONS pass through; native mobile apps (no Origin/Referer) also pass.
    if (!isOriginAllowed(request)) {
      logEvent('warn', 'csrf_blocked', { path, origin: request.headers.get('Origin') || null });
      return withCors(apiError('CSRF_BLOCKED', 'Cross-origin request blocked'));
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
      if (path === '/api/auth/refresh' && request.method === 'POST') {
        // Rate limit refresh by IP to blunt refresh-token guessing
        const refIp = request.headers.get('CF-Connecting-IP') || 'unknown';
        const refRl = await rateLimit(env, `ip:${refIp}`, '/api/auth/refresh');
        if (!refRl.ok) return withCors(errorResponse('Too many refresh attempts', 429));
        return withCors(await handleRefresh(request, env));
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

      if (path === '/api/client-errors' && request.method === 'POST') {
        try {
          const body = await request.json() as { errors?: { message: string; source?: string; line?: number; col?: number; stack?: string; ts: number }[] };
          const errors = (body.errors || []).slice(0, 20);
          for (const e of errors) {
            logEvent('error', 'client_error', { message: String(e.message).slice(0, 500), source: e.source, line: e.line, stack: String(e.stack || '').slice(0, 1000), ts: e.ts });
          }
        } catch { /* ignore malformed */ }
        return withCors(jsonResponse({ ok: true }));
      }

      if (path === '/api/config' && request.method === 'GET') {
        return withCors(jsonResponse({
          pow_enabled: true,
          pow_difficulty: parseInt(env.POW_DIFFICULTY || '18', 10),
        }));
      }
      if (path === '/api/features/pow/challenge' && request.method === 'GET') {
        const ip = request.headers.get('CF-Connecting-IP') || 'unknown';
        const difficulty = Math.min(Math.max(parseInt(env.POW_DIFFICULTY || '18', 10) || 18, 12), 24);
        return withCors(jsonResponse(await createPowChallenge(env, difficulty, ip)));
      }
      if (path === '/api/features/transparency' && request.method === 'GET') {
        const reports = await env.DB.prepare(
          `SELECT id, period_start, period_end, published_at, requests_received, requests_complied, accounts_affected, notes, signed_by
           FROM transparency_reports
           ORDER BY published_at DESC
           LIMIT 8`
        ).all();
        return withCors(jsonResponse({ reports: reports.results }));
      }
      if (path === '/api/features/supporters' && request.method === 'GET') {
        const supporters = await env.DB.prepare(
          `SELECT id, username, display_name, donor_tier, donor_recurring, donor_since
           FROM users
           WHERE donor_tier IS NOT NULL
           ORDER BY donor_recurring DESC, COALESCE(donor_since, created_at) ASC
           LIMIT 200`
        ).all();
        return withCors(jsonResponse({ supporters: supporters.results }));
      }
      // Warrant canary — public, no auth
      if (path === '/api/features/canary' && request.method === 'GET') {
        return withCors(await handleFeatures(request, env, { userId: '', username: '', tier: 'free', deviceId: '' } as Session, url));
      }

      // QR auth — generate and poll are public, authorize requires auth
      if (path === '/api/auth/qr/generate' && request.method === 'POST') {
        return withCors(await handleQrAuth(request, env, 'generate', url));
      }

      if (path.startsWith('/api/auth/qr/poll/') && request.method === 'GET') {
        return withCors(await handleQrAuth(request, env, 'poll', url));
      }

      // Avatar serving — public (img tags cannot send Authorization headers)
      if (path.startsWith('/api/me/avatar/') && request.method === 'GET') {
        const avatarId = path.split('/api/me/avatar/')[1];
        if (!avatarId) return withCors(errorResponse('Missing avatar ID', 400));
        const userId = url.searchParams.get('uid');
        if (!userId) return withCors(errorResponse('Missing uid param', 400));
        const obj = await env.MEDIA.get(`avatars/${userId}/${avatarId}`);
        if (!obj) return withCors(errorResponse('Avatar not found', 404));
        return withCors(new Response(obj.body, {
          headers: {
            'content-type': obj.httpMetadata?.contentType || 'image/jpeg',
            'cache-control': 'public, max-age=86400',
            'x-content-type-options': 'nosniff',
            'x-frame-options': 'DENY',
          },
        }));
      }

      // WebSocket upgrade — BEFORE general auth check because browsers
      // cannot set Authorization headers on WebSocket connections.
      // Auth is verified via query params instead.
      if (path.startsWith('/api/ws/') && request.headers.get('Upgrade') === 'websocket') {
        const conversationId = path.split('/api/ws/')[1];
        if (!conversationId) {
          return withCors(errorResponse('Missing conversation ID', 400));
        }

        const wsToken = url.searchParams.get('token');
        const wsTicket = url.searchParams.get('ticket');
        const wsUserId = url.searchParams.get('userId');

        let wsSessionUserId: string | null = null;

        if (wsTicket) {
          // Preferred: short-lived ticket (30s TTL, single-use)
          const ticketData = await env.KV.get(`ws-ticket:${wsTicket}`, 'json') as { userId: string; deviceId: string } | null;
          if (ticketData) {
            wsSessionUserId = ticketData.userId;
            await env.KV.delete(`ws-ticket:${wsTicket}`); // single-use
          }
        } else if (wsToken && wsUserId) {
          // Legacy fallback: session token in query string
          const wsSession = await env.KV.get(`session:${wsToken}`, 'json') as {
            userId: string; deviceId: string; expiresAt: number;
          } | null;
          if (wsSession && wsSession.userId === wsUserId && Date.now() / 1000 <= wsSession.expiresAt) {
            wsSessionUserId = wsSession.userId;
          }
        }

        if (!wsSessionUserId) {
          return withCors(errorResponse('Invalid session', 401));
        }

        // Verify conversation membership
        const wsMembership = await env.DB.prepare(
          'SELECT 1 FROM conversation_members WHERE conversation_id = ? AND user_id = ?',
        )
          .bind(conversationId, wsSessionUserId)
          .first();

        if (!wsMembership) {
          return withCors(errorResponse('Not a member of this conversation', 403));
        }

        // Route to Durable Object
        const roomId = env.CHAT_ROOM.idFromName(conversationId);
        const room = env.CHAT_ROOM.get(roomId);
        return room.fetch(request);
      }

      // ── Authenticated routes ──
      const session = await verifySession(request, env);
      if (!session) {
        return withCors(errorResponse('Unauthorized', 401));
      }

      // Issue short-lived WebSocket ticket (30s TTL)
      if (path === '/api/ws/ticket' && request.method === 'POST') {
        const ticket = crypto.randomUUID();
        await env.KV.put(`ws-ticket:${ticket}`, JSON.stringify({
          userId: session.userId,
          deviceId: session.deviceId,
        }), { expirationTtl: 30 });
        return withCors(jsonResponse({ ticket }));
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

      // ICE servers (TURN credentials) for WebRTC calls
      if (path === '/api/calls/ice-servers' && request.method === 'GET') {
        // Independent STUN servers — no Google, no surveillance
        const servers: { urls: string; username?: string; credential?: string }[] = [
          { urls: 'stun:stun.stunprotocol.org:3478' },
          { urls: 'stun:stun.nextcloud.com:3478' },
        ];
        if (env.TURN_SECRET && env.TURN_SERVER) {
          // Generate time-limited TURN credentials (RFC 5766 TURN REST API,
          // coturn supports SHA-256 when configured with `hmac-algorithm=sha256`).
          const ttl = 86400; // 24 hours
          const expiry = Math.floor(Date.now() / 1000) + ttl;
          const username = `${expiry}:${session.userId}`;
          const key = await crypto.subtle.importKey(
            'raw',
            new TextEncoder().encode(env.TURN_SECRET),
            { name: 'HMAC', hash: 'SHA-256' },
            false,
            ['sign'],
          );
          const mac = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(username));
          const credential = btoa(String.fromCharCode(...new Uint8Array(mac)));
          servers.push(
            { urls: `turn:${env.TURN_SERVER}:3478`, username, credential },
            { urls: `turn:${env.TURN_SERVER}:443?transport=tcp`, username, credential },
          );
        }
        return withCors(jsonResponse({ iceServers: servers }));
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

      // Business features (paid — org management, compliance, etc.)
      if (path.startsWith('/api/business')) {
        return withCors(await handleBusiness(request, env, session, url));
      }

      // Premium features (free — scheduled msgs, folders, contacts)
      if (path.startsWith('/api/features')) {
        return withCors(await handleFeatures(request, env, session, url));
      }

      // Group moderation (promote, kick, mute)
      if (path.startsWith('/api/groups/')) {
        return withCors(await handleGroups(request, env, session, url));
      }

      // Link-preview unfurler (Open Graph) — KV-cached for 24h.
      if (path === '/api/link-preview') {
        const lpRes = await handleLinkPreview(request, env, url);
        const lpHeaders = new Headers(lpRes.headers);
        lpHeaders.set('Cache-Control', 'private, max-age=300');
        return withCors(new Response(lpRes.body, { status: lpRes.status, headers: lpHeaders }));
      }

      // Crypto Donation — the only payment method. No Stripe. No Apple. No Google.
      // RocChat accepts crypto donations only — fully decentralized, no middlemen.
      if (path === '/api/billing/crypto/checkout' && request.method === 'POST') {
        const body = await request.json() as { type?: 'donation' | 'business'; amount?: number; recurring?: boolean };
        const checkoutType = body.type === 'business' ? 'business' : 'donation';
        const amountUsdCents = checkoutType === 'business'
          ? 399
          : Math.min(Math.max(Math.round((body.amount || 5) * 100), 100), 250000);

        const rate = Math.max(parseFloat(env.CRYPTO_USDC_RATE || '1'), 0.000001);
        const amountCrypto = (amountUsdCents / 100 / rate).toFixed(6);
        const walletAddress = env.CRYPTO_WALLET_ADDRESS || '0x0000000000000000000000000000000000000000';
        const intentId = crypto.randomUUID();

        await env.DB.prepare(
          `INSERT INTO crypto_checkout_intents (id, user_id, checkout_type, amount_usd_cents, crypto_symbol, amount_crypto, wallet_address, recurring)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
        ).bind(intentId, session.userId, checkoutType, amountUsdCents, 'USDC', amountCrypto, walletAddress, body.recurring ? 1 : 0).run();

        return withCors(jsonResponse({
          id: intentId,
          checkout_type: checkoutType,
          amount_usd_cents: amountUsdCents,
          crypto_symbol: 'USDC',
          amount_crypto: amountCrypto,
          wallet_address: walletAddress,
          memo: `rocchat:${intentId}`,
          status: 'pending',
        }));
      }

      if (path === '/api/billing/crypto/confirm' && request.method === 'POST') {
        const body = await request.json() as { intent_id?: string; tx_hash?: string };
        if (!body.intent_id || !body.tx_hash) return withCors(errorResponse('Missing intent_id or tx_hash', 400));

        const intent = await env.DB.prepare(
          `SELECT id, checkout_type, recurring FROM crypto_checkout_intents WHERE id = ? AND user_id = ?`
        ).bind(body.intent_id, session.userId).first<{ id: string; checkout_type: string; recurring: number }>();
        if (!intent) return withCors(errorResponse('Intent not found', 404));

        await env.DB.prepare(
          `UPDATE crypto_checkout_intents SET status = 'confirmed', tx_hash = ?, confirmed_at = unixepoch() WHERE id = ?`
        ).bind(body.tx_hash, body.intent_id).run();

        if (intent.checkout_type === 'business') {
          await env.DB.prepare(`UPDATE users SET account_tier = 'business' WHERE id = ?`).bind(session.userId).run();
        } else {
          await env.DB.prepare(
            `UPDATE users SET donor_tier = ?, donor_recurring = ?, donor_since = COALESCE(donor_since, unixepoch()) WHERE id = ?`
          ).bind(intent.recurring ? 'wing' : 'feather', intent.recurring ? 1 : 0, session.userId).run();
        }

        return withCors(jsonResponse({ ok: true }));
      }

      // No Apple IAP. No Google Play billing. No corporate middlemen.
      // All features are free. Donations via crypto only.

      // All features are free. Crypto donations only — no corporate payment processors.

      // User profile/settings
      if (path === '/api/me' && request.method === 'GET') {
        const user = await env.DB.prepare(
          `SELECT id, username, display_name, identity_key, avatar_url, account_tier, discoverable,
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

        // Validate input lengths to prevent abuse
        if (typeof body.display_name === 'string' && (body.display_name.length < 1 || body.display_name.length > 64)) {
          return withCors(errorResponse('Display name must be 1-64 characters', 400));
        }
        const validOnlineTo = ['everyone', 'contacts', 'nobody'];
        if (body.show_online_to && !validOnlineTo.includes(body.show_online_to as string)) {
          return withCors(errorResponse('Invalid online visibility option', 400));
        }
        const validWhoCanAdd = ['everyone', 'nobody'];
        if (body.who_can_add && !validWhoCanAdd.includes(body.who_can_add as string)) {
          return withCors(errorResponse('Invalid who_can_add option', 400));
        }

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

      // Profile photo upload/delete
      if (path === '/api/me/avatar' && request.method === 'POST') {
        const contentLength = request.headers.get('content-length');
        if (contentLength && parseInt(contentLength, 10) > 5 * 1024 * 1024) {
          return withCors(errorResponse('Avatar too large (max 5MB)', 413));
        }
        const ct = request.headers.get('content-type') || '';
        if (!ct.startsWith('image/')) {
          return withCors(errorResponse('Only image files are accepted', 415));
        }
        const body = request.body;
        if (!body) return withCors(errorResponse('Empty body', 400));
        const avatarId = crypto.randomUUID();
        const r2Key = `avatars/${session.userId}/${avatarId}`;
        await env.MEDIA.put(r2Key, body, {
          httpMetadata: { contentType: ct },
          customMetadata: { uploaderId: session.userId },
        });
        const avatarUrl = `/me/avatar/${avatarId}`;
        await env.DB.prepare('UPDATE users SET avatar_url = ? WHERE id = ?')
          .bind(avatarUrl, session.userId).run();
        return withCors(jsonResponse({ avatar_url: avatarUrl }));
      }

      if (path === '/api/me/avatar' && request.method === 'DELETE') {
        const user = await env.DB.prepare('SELECT avatar_url FROM users WHERE id = ?')
          .bind(session.userId).first<{ avatar_url: string | null }>();
        if (user?.avatar_url) {
          const parts = user.avatar_url.split('/');
          const avatarId = parts[parts.length - 1];
          await env.MEDIA.delete(`avatars/${session.userId}/${avatarId}`);
          await env.DB.prepare('UPDATE users SET avatar_url = NULL WHERE id = ?')
            .bind(session.userId).run();
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

      // Device verification — generate 6-digit code
      if (path === '/api/devices/verify/initiate' && request.method === 'POST') {
        const code = String(Math.floor(100000 + Math.random() * 900000));
        await env.KV.put(
          `device_verify:${session.userId}:${code}`,
          JSON.stringify({ userId: session.userId, deviceId: session.deviceId, createdAt: Date.now() }),
          { expirationTtl: 300 },
        );
        return withCors(jsonResponse({ code, expires_in: 300 }));
      }

      // Device verification — confirm code from new device
      if (path === '/api/devices/verify/confirm' && request.method === 'POST') {
        const body = await request.json() as { code?: string };
        if (!body.code) return withCors(errorResponse('Missing code', 400));
        const key = `device_verify:${session.userId}:${body.code}`;
        const stored = await env.KV.get(key);
        if (!stored) return withCors(errorResponse('Invalid or expired code', 403));
        await env.KV.delete(key);
        const data = JSON.parse(stored);
        return withCors(jsonResponse({ ok: true, verified: true, source_device_id: data.deviceId }));
      }

      // Account deletion
      if (path === '/api/me' && request.method === 'DELETE') {
        const userId = session.userId;

        // Delete avatar from R2
        const user = await env.DB.prepare('SELECT avatar_url FROM users WHERE id = ?')
          .bind(userId).first<{ avatar_url: string | null }>();
        if (user?.avatar_url) {
          const parts = user.avatar_url.split('/');
          const avatarId = parts[parts.length - 1];
          await env.MEDIA.delete(`avatars/${userId}/${avatarId}`);
        }

        // Delete messages sent by this user
        await env.DB.prepare('DELETE FROM messages WHERE sender_id = ?').bind(userId).run();

        // Delete user row (cascades to devices, keys, contacts, conversation_members)
        await env.DB.prepare('DELETE FROM users WHERE id = ?').bind(userId).run();

        // Clean up empty conversations (no members left)
        await env.DB.prepare(
          `DELETE FROM conversations WHERE id NOT IN (SELECT DISTINCT conversation_id FROM conversation_members)`
        ).run();

        // Invalidate current session
        const authHeader = request.headers.get('Authorization') || '';
        const token = authHeader.replace('Bearer ', '');
        if (token) await env.KV.delete(`session:${token}`);

        return withCors(jsonResponse({ ok: true, deleted: true }));
      }

      // Session ping (heartbeat)
      if (path === '/api/ping') {
        return withCors(jsonResponse({ ok: true }));
      }

      return withCors(errorResponse('Not found', 404));
    } catch (err) {
      logEvent('error', 'request_error', {
        path,
        method: request.method,
        message: err instanceof Error ? err.message : String(err),
      });
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

    // Send scheduled messages that are due
    const due = await env.DB.prepare(
      'SELECT id, conversation_id, sender_id, encrypted FROM scheduled_messages WHERE sent = 0 AND scheduled_at <= unixepoch() LIMIT 50'
    ).all();
    for (const msg of due.results) {
      const msgId = crypto.randomUUID();
      await env.DB.prepare(
        'INSERT INTO messages (id, conversation_id, sender_id, encrypted, server_timestamp) VALUES (?, ?, ?, ?, unixepoch())'
      ).bind(msgId, msg.conversation_id, msg.sender_id, msg.encrypted).run();
      await env.DB.prepare('UPDATE scheduled_messages SET sent = 1 WHERE id = ?').bind(msg.id).run();
    }

    // Auto-delete messages per retention policies
    const policies = await env.DB.prepare(
      'SELECT org_id, max_age_days FROM retention_policies WHERE auto_delete = 1'
    ).all();
    for (const p of policies.results) {
      const maxAge = p.max_age_days as number;
      const orgId = p.org_id as string;
      // Get org member IDs
      const members = await env.DB.prepare(
        'SELECT user_id FROM organization_members WHERE org_id = ?'
      ).bind(orgId).all();
      const memberIds = members.results.map((m: Record<string, unknown>) => m.user_id as string);
      if (memberIds.length === 0) continue;
      const ph = memberIds.map(() => '?').join(',');
      await env.DB.prepare(`
        DELETE FROM messages WHERE sender_id IN (${ph})
        AND server_timestamp < unixepoch() - ?
      `).bind(...memberIds, maxAge * 86400).run();
    }
  },
};

// ── Helpers ──

function corsHeaders(request?: Request): HeadersInit {
  const origin = request?.headers.get('Origin') || '';
  const allowed = ['https://chat.mocipher.com', 'https://rocchat-8x7.pages.dev', 'http://localhost:5173'];
  // Only return CORS headers for known origins — unknown origins get no Access-Control-Allow-Origin
  if (!allowed.includes(origin)) {
    return { 'Vary': 'Origin' };
  }
  return {
    'Access-Control-Allow-Origin': origin,
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
  headers.set('Permissions-Policy', 'camera=(self), microphone=(self), geolocation=()');
  headers.set(
    'Content-Security-Policy',
    "default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; font-src 'self'; connect-src 'self' wss://chat.mocipher.com wss://rocchat-api.spoass.workers.dev https://rocchat-api.spoass.workers.dev; img-src 'self' data: blob:; frame-ancestors 'none'; base-uri 'none'; form-action 'self'; manifest-src 'self';",
  );
  headers.set('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}
