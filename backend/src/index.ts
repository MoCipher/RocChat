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
import { handleChannels } from './channels.js';
import { createPowChallenge, getPowDifficulty } from './pow.js';
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
  SCHEDULER_SECRET?: string;
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
        if (!loginRl.ok) return withCors(new Response(JSON.stringify({ error: 'Too many login attempts', code: 'RATE_LIMITED', retry_after: loginRl.retryAfter ?? 60 }), { status: 429, headers: { 'Content-Type': 'application/json', 'Retry-After': String(loginRl.retryAfter ?? 60) } }));
        return withCors(await handleAuth(request, env, 'login'));
      }
      if (path === '/api/auth/refresh' && request.method === 'POST') {
        // Rate limit refresh by IP to blunt refresh-token guessing
        const refIp = request.headers.get('CF-Connecting-IP') || 'unknown';
        const refRl = await rateLimit(env, `ip:${refIp}`, '/api/auth/refresh');
        if (!refRl.ok) return withCors(new Response(JSON.stringify({ error: 'Too many refresh attempts', code: 'RATE_LIMITED', retry_after: refRl.retryAfter ?? 60 }), { status: 429, headers: { 'Content-Type': 'application/json', 'Retry-After': String(refRl.retryAfter ?? 60) } }));
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

      // External scheduler hook (for accounts that are out of cron slots).
      if (path === '/api/internal/maintenance/run' && request.method === 'POST') {
        const configuredSecret = env.SCHEDULER_SECRET;
        if (!configuredSecret) {
          logEvent('warn', 'maintenance_secret_missing', {});
          return withCors(errorResponse('Maintenance scheduler is not configured', 503));
        }
        const presentedSecret = request.headers.get('x-scheduler-secret') || '';
        if (!constantTimeEqual(presentedSecret, configuredSecret)) {
          logEvent('warn', 'maintenance_forbidden', {
            ip: request.headers.get('CF-Connecting-IP') || null,
          });
          return withCors(errorResponse('Forbidden', 403));
        }
        const summary = await runMaintenanceTasks(env);
        return withCors(jsonResponse({
          ok: true,
          ran_at: new Date().toISOString(),
          summary,
        }));
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
        const difficulty = await getPowDifficulty(env);
        return withCors(jsonResponse({
          pow_enabled: true,
          pow_difficulty: difficulty,
        }));
      }
      if (path === '/api/features/pow/challenge' && request.method === 'GET') {
        const ip = request.headers.get('CF-Connecting-IP') || 'unknown';
        const difficulty = await getPowDifficulty(env);
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

      // VAPID public key — public, no auth
      if (path === '/api/push/vapid-key' && request.method === 'GET') {
        const vapidKey = await env.KV.get('vapid_public_key');
        return withCors(jsonResponse({ vapid_public_key: vapidKey || null }));
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
        return withCors(new Response(JSON.stringify({ error: 'Rate limit exceeded', code: 'RATE_LIMITED', retry_after: rlResult.retryAfter ?? 60 }), { status: 429, headers: { 'Content-Type': 'application/json', 'Retry-After': String(rlResult.retryAfter ?? 60) } }));
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

      // Key transparency audit log — view a user's key change history
      if (path.startsWith('/api/key-audit/') && request.method === 'GET') {
        const targetUserId = path.split('/api/key-audit/')[1];
        if (!targetUserId) return withCors(errorResponse('Missing user ID', 400));
        const result = await env.DB.prepare(
          `SELECT event_type, new_key_fingerprint, old_key_fingerprint, created_at
           FROM key_audit_log WHERE user_id = ? ORDER BY created_at DESC LIMIT 50`,
        ).bind(targetUserId).all();
        return withCors(jsonResponse(result.results));
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

      // Channels & Communities
      if (path.startsWith('/api/channels') || path.startsWith('/api/communities')) {
        const channelRes = await handleChannels(request, env, session, url);
        if (channelRes) return withCors(channelRes);
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
                  who_can_add, default_disappear_timer, status_text, created_at
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
        if (body.show_last_seen_to && !validOnlineTo.includes(body.show_last_seen_to as string)) {
          return withCors(errorResponse('Invalid last seen visibility option', 400));
        }
        if (body.show_photo_to && !validOnlineTo.includes(body.show_photo_to as string)) {
          return withCors(errorResponse('Invalid photo visibility option', 400));
        }

        if (typeof body.status_text === 'string' && body.status_text.length > 140) {
          return withCors(errorResponse('Status must be 140 characters or less', 400));
        }

        const allowed = [
          'display_name', 'discoverable',
          'show_read_receipts', 'show_typing_indicator',
          'show_online_to', 'who_can_add', 'default_disappear_timer', 'status_text',
          'show_last_seen_to', 'show_photo_to', 'screenshot_detection',
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

      // ── Recovery vault ─────────────────────────────────────────────
      // Upload encrypted key bundle (encrypted with BIP39 recovery key)
      if (path === '/api/recovery/vault' && request.method === 'POST') {
        const body = (await request.json()) as { blob?: string };
        if (!body.blob) return withCors(errorResponse('Missing blob', 400));
        await env.KV.put(`recovery_vault:${session.userId}`, body.blob);
        return withCors(jsonResponse({ ok: true }));
      }

      // Download recovery vault blob (for mnemonic-based recovery)
      if (path === '/api/recovery/vault' && request.method === 'GET') {
        const blob = await env.KV.get(`recovery_vault:${session.userId}`);
        if (!blob) return withCors(errorResponse('No recovery vault found', 404));
        return withCors(jsonResponse({ blob }));
      }

      // ── Device key transfer ────────────────────────────────────────
      // New device requests key transfer (posts ephemeral public key)
      if (path === '/api/devices/key-transfer/request' && request.method === 'POST') {
        const body = (await request.json()) as { ephemeralPub?: string; deviceId?: string };
        if (!body.ephemeralPub) return withCors(errorResponse('Missing ephemeralPub', 400));
        const requestId = crypto.randomUUID();
        await env.KV.put(
          `key_transfer_req:${session.userId}:${requestId}`,
          JSON.stringify({
            requestId,
            deviceId: body.deviceId || session.deviceId,
            ephemeralPub: body.ephemeralPub,
            createdAt: Date.now(),
          }),
          { expirationTtl: 300 },
        );
        // Also store a pointer so source device can find pending requests
        const pendingList = JSON.parse((await env.KV.get(`key_transfer_pending:${session.userId}`)) || '[]');
        pendingList.push(requestId);
        await env.KV.put(`key_transfer_pending:${session.userId}`, JSON.stringify(pendingList), {
          expirationTtl: 300,
        });
        return withCors(jsonResponse({ ok: true, requestId }));
      }

      // Source device polls for pending key transfer requests
      if (path === '/api/devices/key-transfer/pending' && request.method === 'GET') {
        const pendingList = JSON.parse(
          (await env.KV.get(`key_transfer_pending:${session.userId}`)) || '[]',
        );
        const requests = [];
        for (const reqId of pendingList) {
          const data = await env.KV.get(`key_transfer_req:${session.userId}:${reqId}`);
          if (data) requests.push(JSON.parse(data));
        }
        return withCors(jsonResponse({ requests }));
      }

      // Source device uploads encrypted key bundle for a specific request
      if (path === '/api/devices/key-transfer/bundle' && request.method === 'POST') {
        const body = (await request.json()) as {
          requestId?: string;
          encryptedBundle?: string;
          ephemeralPub?: string;
        };
        if (!body.requestId || !body.encryptedBundle || !body.ephemeralPub) {
          return withCors(errorResponse('Missing fields', 400));
        }
        await env.KV.put(
          `key_transfer_bundle:${session.userId}:${body.requestId}`,
          JSON.stringify({
            encryptedBundle: body.encryptedBundle,
            ephemeralPub: body.ephemeralPub,
          }),
          { expirationTtl: 300 },
        );
        return withCors(jsonResponse({ ok: true }));
      }

      // New device fetches the encrypted key bundle
      if (path === '/api/devices/key-transfer/bundle' && request.method === 'GET') {
        const requestId = new URL(request.url).searchParams.get('requestId');
        if (!requestId) return withCors(errorResponse('Missing requestId', 400));
        const data = await env.KV.get(`key_transfer_bundle:${session.userId}:${requestId}`);
        if (!data) return withCors(jsonResponse({ ready: false }));
        const parsed = JSON.parse(data);
        // Clean up after retrieval
        await env.KV.delete(`key_transfer_bundle:${session.userId}:${requestId}`);
        await env.KV.delete(`key_transfer_req:${session.userId}:${requestId}`);
        return withCors(jsonResponse({ ready: true, ...parsed }));
      }

      // Data export
      if (path === '/api/me/export' && request.method === 'GET') {
        const userId = session.userId;
        const user = await env.DB.prepare(
          'SELECT id, username, display_name, status_text, created_at FROM users WHERE id = ?'
        ).bind(userId).first();
        const contacts = await env.DB.prepare(
          'SELECT c.contact_user_id, u.username, u.display_name, c.verified, c.created_at FROM contacts c LEFT JOIN users u ON c.contact_user_id = u.id WHERE c.user_id = ?'
        ).bind(userId).all();
        const conversations = await env.DB.prepare(
          `SELECT cm.conversation_id, c.type, c.name, cm.role, cm.joined_at
           FROM conversation_members cm JOIN conversations c ON cm.conversation_id = c.id
           WHERE cm.user_id = ?`
        ).bind(userId).all();
        const devices = await env.DB.prepare(
          'SELECT id, device_name, platform, created_at, last_active_at FROM devices WHERE user_id = ?'
        ).bind(userId).all();
        const exportData = {
          account: user,
          contacts: contacts.results,
          conversations: conversations.results,
          devices: devices.results,
          exported_at: new Date().toISOString(),
        };
        return withCors(jsonResponse({ ok: true, export: exportData }));
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

      // ── Roc Client (canary) opt-in ──────────────────────────────
      // GET  -> { enabled: bool, channel: 'stable' | 'roc' }
      // POST -> { enabled: bool } persists choice on the user record.
      // The web client uses this to gate experimental features. Server
      // never *forces* canary; it's a per-user opt-in.
      if (path === '/api/canary' && request.method === 'GET') {
        const enabled = (await env.KV.get(`canary:${session.userId}`)) === '1';
        return withCors(jsonResponse({ enabled, channel: enabled ? 'roc' : 'stable' }));
      }
      if (path === '/api/canary' && request.method === 'POST') {
        const body = (await request.json()) as { enabled?: boolean };
        if (body.enabled) {
          await env.KV.put(`canary:${session.userId}`, '1');
        } else {
          await env.KV.delete(`canary:${session.userId}`);
        }
        return withCors(jsonResponse({ ok: true, enabled: !!body.enabled }));
      }

      // ── Encrypted export ────────────────────────────────────────
      // Returns a server-built archive of the caller's data (already
      // E2EE-encrypted at rest, so the export is a pass-through). The
      // client wraps the result with an Argon2id-derived passphrase key
      // before writing it to disk.
      if (path === '/api/export' && request.method === 'GET') {
        const [profile, convs, msgs, contacts, devices] = await Promise.all([
          env.DB.prepare('SELECT id, username, display_name, identity_key, created_at FROM users WHERE id = ?').bind(session.userId).first(),
          env.DB.prepare('SELECT c.id, c.kind, c.created_at FROM conversations c JOIN conversation_members m ON m.conversation_id = c.id WHERE m.user_id = ?').bind(session.userId).all(),
          env.DB.prepare('SELECT id, conversation_id, sender_id, encrypted, server_timestamp FROM messages WHERE sender_id = ? ORDER BY server_timestamp DESC LIMIT 5000').bind(session.userId).all(),
          env.DB.prepare('SELECT contact_id, created_at FROM contacts WHERE user_id = ?').bind(session.userId).all(),
          env.DB.prepare('SELECT id, name, last_active FROM devices WHERE user_id = ?').bind(session.userId).all(),
        ]);
        return withCors(jsonResponse({
          exported_at: Date.now(),
          format: 'rocchat-export-v1',
          profile,
          conversations: convs.results,
          messages: msgs.results,
          contacts: contacts.results,
          devices: devices.results,
        }));
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
  async scheduled(_event: ScheduledEvent, env: Env, _ctx: ExecutionContext) {
    await runMaintenanceTasks(env);
  },
};

// ── Helpers ──

interface MaintenanceSummary {
  expired_messages_deleted: number;
  used_prekeys_deleted: number;
  stale_rate_log_deleted: number;
  scheduled_messages_sent: number;
  retention_orgs_processed: number;
  retention_messages_deleted: number;
}

async function runMaintenanceTasks(env: Env): Promise<MaintenanceSummary> {
  const expiredRes = await env.DB.prepare('DELETE FROM messages WHERE expires_at IS NOT NULL AND expires_at < unixepoch()').run();

  const preKeysRes = await env.DB.prepare('DELETE FROM one_time_pre_keys WHERE used = 1').run();

  const rateLogRes = await env.DB.prepare('DELETE FROM rate_log WHERE ts < unixepoch() - 3600').run();

  // Send scheduled messages that are due.
  const due = await env.DB.prepare(
    'SELECT id, conversation_id, sender_id, encrypted FROM scheduled_messages WHERE sent = 0 AND scheduled_at <= unixepoch() LIMIT 50'
  ).all();
  const dueMessages = due.results as Array<{
    id: string;
    conversation_id: string;
    sender_id: string;
    encrypted: string;
  }>;
  let scheduledMessagesSent = 0;
  for (const msg of dueMessages) {
    const msgId = crypto.randomUUID();
    await env.DB.prepare(
      'INSERT INTO messages (id, conversation_id, sender_id, encrypted, server_timestamp) VALUES (?, ?, ?, ?, unixepoch())'
    ).bind(msgId, msg.conversation_id, msg.sender_id, msg.encrypted).run();
    const markSentRes = await env.DB.prepare('UPDATE scheduled_messages SET sent = 1 WHERE id = ?').bind(msg.id).run();
    scheduledMessagesSent += Number(markSentRes.meta?.changes || 0);
  }

  // Auto-delete messages per retention policies.
  const policies = await env.DB.prepare(
    'SELECT org_id, max_age_days FROM retention_policies WHERE auto_delete = 1'
  ).all();
  const retentionPolicies = policies.results as Array<{ org_id: string; max_age_days: number }>;
  let retentionMessagesDeleted = 0;
  let retentionOrgsProcessed = 0;
  for (const p of retentionPolicies) {
    const maxAge = Number(p.max_age_days || 0);
    const orgId = p.org_id;
    const members = await env.DB.prepare(
      'SELECT user_id FROM organization_members WHERE org_id = ?'
    ).bind(orgId).all();
    const memberIds = (members.results as Array<{ user_id: string }>).map((m) => m.user_id);
    if (memberIds.length === 0 || maxAge <= 0) continue;
    retentionOrgsProcessed += 1;
    const ph = memberIds.map(() => '?').join(',');
    const delRes = await env.DB.prepare(`
      DELETE FROM messages WHERE sender_id IN (${ph})
      AND server_timestamp < unixepoch() - ?
    `).bind(...memberIds, maxAge * 86400).run();
    retentionMessagesDeleted += Number(delRes.meta?.changes || 0);
  }

  return {
    expired_messages_deleted: Number(expiredRes.meta?.changes || 0),
    used_prekeys_deleted: Number(preKeysRes.meta?.changes || 0),
    stale_rate_log_deleted: Number(rateLogRes.meta?.changes || 0),
    scheduled_messages_sent: scheduledMessagesSent,
    retention_orgs_processed: retentionOrgsProcessed,
    retention_messages_deleted: retentionMessagesDeleted,
  };
}

function constantTimeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let mismatch = 0;
  for (let i = 0; i < a.length; i += 1) {
    mismatch |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return mismatch === 0;
}

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
  headers.set('Permissions-Policy', 'camera=(self), microphone=(self), geolocation=(), interest-cohort=(), browsing-topics=(), serial=(), usb=(), bluetooth=(), gamepad=(), magnetometer=(), accelerometer=(), gyroscope=(), payment=()');
  headers.set(
    'Content-Security-Policy',
    "default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; font-src 'self'; connect-src 'self' wss://chat.mocipher.com wss://rocchat-api.spoass.workers.dev https://rocchat-api.spoass.workers.dev; img-src 'self' data: blob:; frame-ancestors 'none'; base-uri 'none'; form-action 'self'; manifest-src 'self'; object-src 'none';",
  );
  headers.set('Strict-Transport-Security', 'max-age=63072000; includeSubDomains; preload');
  headers.set('Cross-Origin-Opener-Policy', 'same-origin');
  headers.set('Cross-Origin-Resource-Policy', 'same-origin');
  headers.set('X-DNS-Prefetch-Control', 'off');
  headers.set('X-Permitted-Cross-Domain-Policies', 'none');
  headers.set('Origin-Agent-Cluster', '?1');
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}
