/**
 * RocChat Backend — Business Features
 *
 * Organization management, admin dashboard, compliance tools.
 * Business tier ($3.99/user/month) — requires paid subscription.
 */

import type { Env } from './index.js';
import type { Session } from './middleware.js';
import { jsonResponse, errorResponse } from './middleware.js';

async function requireBusiness(env: Env, userId: string): Promise<Response | null> {
  const user = await env.DB.prepare('SELECT account_tier FROM users WHERE id = ?')
    .bind(userId).first<{ account_tier: string }>();
  if (!user || user.account_tier !== 'business') {
    return errorResponse('Business subscription required', 403);
  }
  return null;
}

async function requireOrgAdmin(env: Env, orgId: string, userId: string): Promise<Response | null> {
  const member = await env.DB.prepare(
    'SELECT role FROM organization_members WHERE org_id = ? AND user_id = ?'
  ).bind(orgId, userId).first<{ role: string }>();
  if (!member || (member.role !== 'owner' && member.role !== 'admin')) {
    return errorResponse('Admin access required', 403);
  }
  return null;
}

export async function handleBusiness(
  request: Request,
  env: Env,
  session: Session,
  url: URL,
): Promise<Response> {
  const path = url.pathname;

  // Check business tier for all endpoints
  const tierCheck = await requireBusiness(env, session.userId);
  if (tierCheck) return tierCheck;

  // ── Organization CRUD ──

  // POST /api/business/org — Create organization
  if (path === '/api/business/org' && request.method === 'POST') {
    const body = await request.json() as Record<string, unknown>;
    const name = body.name as string;
    if (!name || name.length < 1 || name.length > 100) {
      return errorResponse('Organization name must be 1-100 characters', 400);
    }
    const orgId = crypto.randomUUID();
    await env.DB.prepare(
      'INSERT INTO organizations (id, name, owner_id, accent_color) VALUES (?, ?, ?, ?)'
    ).bind(orgId, name, session.userId, (body.accent_color as string) || '#D4AF37').run();

    // Add creator as owner
    await env.DB.prepare(
      'INSERT INTO organization_members (org_id, user_id, role) VALUES (?, ?, ?)'
    ).bind(orgId, session.userId, 'owner').run();

    return jsonResponse({ org_id: orgId });
  }

  // GET /api/business/org — List user's organizations
  if (path === '/api/business/org' && request.method === 'GET') {
    const orgs = await env.DB.prepare(`
      SELECT o.id, o.name, o.logo_url, o.accent_color, om.role, o.created_at
      FROM organizations o
      JOIN organization_members om ON o.id = om.org_id
      WHERE om.user_id = ?
      ORDER BY o.created_at DESC
    `).bind(session.userId).all();
    return jsonResponse(orgs.results);
  }

  // GET /api/business/org/:id — Get org details
  if (path.startsWith('/api/business/org/') && request.method === 'GET') {
    const parts = path.split('/');
    const orgId = parts[4];
    if (!orgId || parts.length > 5) return errorResponse('Invalid path', 400);

    const org = await env.DB.prepare('SELECT * FROM organizations WHERE id = ?')
      .bind(orgId).first();
    if (!org) return errorResponse('Organization not found', 404);

    const members = await env.DB.prepare(`
      SELECT om.user_id, om.role, om.joined_at, u.username, u.display_name, u.avatar_url
      FROM organization_members om
      JOIN users u ON u.id = om.user_id
      WHERE om.org_id = ?
      ORDER BY om.role, om.joined_at
    `).bind(orgId).all();

    return jsonResponse({ ...org, members: members.results });
  }

  // PATCH /api/business/org/:id — Update org
  if (path.startsWith('/api/business/org/') && request.method === 'PATCH') {
    const parts = path.split('/');
    const orgId = parts[4];
    if (!orgId || parts.length > 5) return errorResponse('Invalid path', 400);

    const adminCheck = await requireOrgAdmin(env, orgId, session.userId);
    if (adminCheck) return adminCheck;

    const body = await request.json() as Record<string, unknown>;
    const allowed = ['name', 'accent_color'];
    const updates: string[] = [];
    const values: unknown[] = [];

    for (const key of allowed) {
      if (key in body) {
        if (key === 'name') {
          const name = body.name as string;
          if (!name || name.length < 1 || name.length > 100) {
            return errorResponse('Organization name must be 1-100 characters', 400);
          }
        }
        updates.push(`${key} = ?`);
        values.push(body[key]);
      }
    }

    if (updates.length > 0) {
      values.push(orgId);
      await env.DB.prepare(`UPDATE organizations SET ${updates.join(', ')} WHERE id = ?`)
        .bind(...values).run();
    }
    return jsonResponse({ ok: true });
  }

  // ── Member Management ──

  // POST /api/business/org/:id/members — Add member
  if (path.match(/^\/api\/business\/org\/[^/]+\/members$/) && request.method === 'POST') {
    const orgId = path.split('/')[4];
    const adminCheck = await requireOrgAdmin(env, orgId, session.userId);
    if (adminCheck) return adminCheck;

    const body = await request.json() as { user_id: string; role?: string };
    const role = body.role || 'member';
    if (!['member', 'moderator', 'admin'].includes(role)) {
      return errorResponse('Invalid role', 400);
    }

    // Verify user exists
    const user = await env.DB.prepare('SELECT id FROM users WHERE id = ?').bind(body.user_id).first();
    if (!user) return errorResponse('User not found', 404);

    await env.DB.prepare(
      'INSERT OR REPLACE INTO organization_members (org_id, user_id, role) VALUES (?, ?, ?)'
    ).bind(orgId, body.user_id, role).run();

    return jsonResponse({ ok: true });
  }

  // DELETE /api/business/org/:id/members/:userId — Remove member
  if (path.match(/^\/api\/business\/org\/[^/]+\/members\/[^/]+$/) && request.method === 'DELETE') {
    const parts = path.split('/');
    const orgId = parts[4];
    const targetUserId = parts[6];

    const adminCheck = await requireOrgAdmin(env, orgId, session.userId);
    if (adminCheck) return adminCheck;

    // Can't remove owner
    const target = await env.DB.prepare(
      'SELECT role FROM organization_members WHERE org_id = ? AND user_id = ?'
    ).bind(orgId, targetUserId).first<{ role: string }>();
    if (target?.role === 'owner') return errorResponse('Cannot remove organization owner', 400);

    await env.DB.prepare(
      'DELETE FROM organization_members WHERE org_id = ? AND user_id = ?'
    ).bind(orgId, targetUserId).run();

    return jsonResponse({ ok: true });
  }

  // ── Remote Device Wipe ──

  // POST /api/business/org/:id/wipe — Wipe a user's device
  if (path.match(/^\/api\/business\/org\/[^/]+\/wipe$/) && request.method === 'POST') {
    const orgId = path.split('/')[4];
    const adminCheck = await requireOrgAdmin(env, orgId, session.userId);
    if (adminCheck) return adminCheck;

    const body = await request.json() as { user_id: string; device_id: string };
    // Verify target is org member
    const member = await env.DB.prepare(
      'SELECT user_id FROM organization_members WHERE org_id = ? AND user_id = ?'
    ).bind(orgId, body.user_id).first();
    if (!member) return errorResponse('User not in organization', 400);

    // Delete the device
    await env.DB.prepare('DELETE FROM devices WHERE id = ? AND user_id = ?')
      .bind(body.device_id, body.user_id).run();

    return jsonResponse({ ok: true, wiped_device: body.device_id });
  }

  // ── Compliance Export ──

  // GET /api/business/org/:id/export — Export audit log
  if (path.match(/^\/api\/business\/org\/[^/]+\/export$/) && request.method === 'GET') {
    const orgId = path.split('/')[4];
    const adminCheck = await requireOrgAdmin(env, orgId, session.userId);
    if (adminCheck) return adminCheck;

    // Get all org members
    const members = await env.DB.prepare(
      'SELECT user_id FROM organization_members WHERE org_id = ?'
    ).bind(orgId).all();
    const memberIds = members.results.map((m: Record<string, unknown>) => m.user_id);
    if (memberIds.length === 0) return jsonResponse({ conversations: [], members: [] });

    // Get conversations where org members participate
    const placeholders = memberIds.map(() => '?').join(',');
    const convs = await env.DB.prepare(`
      SELECT DISTINCT c.id, c.type, c.created_at
      FROM conversations c
      JOIN conversation_members cm ON c.id = cm.conversation_id
      WHERE cm.user_id IN (${placeholders})
      ORDER BY c.created_at DESC
      LIMIT 1000
    `).bind(...memberIds).all();

    return jsonResponse({
      org_id: orgId,
      exported_at: Date.now(),
      member_count: memberIds.length,
      conversations: convs.results,
      note: 'Message content is E2E encrypted and cannot be decrypted by the server.',
    });
  }

  // ── Retention Policies ──

  // GET /api/business/org/:id/retention
  if (path.match(/^\/api\/business\/org\/[^/]+\/retention$/) && request.method === 'GET') {
    const orgId = path.split('/')[4];
    const policy = await env.DB.prepare(
      'SELECT * FROM retention_policies WHERE org_id = ?'
    ).bind(orgId).first();
    return jsonResponse(policy || { max_age_days: 365, auto_delete: 0 });
  }

  // PUT /api/business/org/:id/retention
  if (path.match(/^\/api\/business\/org\/[^/]+\/retention$/) && request.method === 'PUT') {
    const orgId = path.split('/')[4];
    const adminCheck = await requireOrgAdmin(env, orgId, session.userId);
    if (adminCheck) return adminCheck;

    const body = await request.json() as { max_age_days: number; auto_delete: number };
    const maxAge = Math.max(1, Math.min(3650, body.max_age_days || 365));

    await env.DB.prepare(`
      INSERT OR REPLACE INTO retention_policies (org_id, max_age_days, auto_delete)
      VALUES (?, ?, ?)
    `).bind(orgId, maxAge, body.auto_delete ? 1 : 0).run();

    return jsonResponse({ ok: true });
  }

  // ── SSO Configuration ──

  // GET /api/business/org/:id/sso — Get SSO config
  if (path.match(/^\/api\/business\/org\/[^/]+\/sso$/) && request.method === 'GET') {
    const orgId = path.split('/')[4];
    const adminCheck = await requireOrgAdmin(env, orgId, session.userId);
    if (adminCheck) return adminCheck;

    const config = await env.DB.prepare(
      'SELECT provider, issuer_url, client_id, redirect_uri, enabled FROM sso_configs WHERE org_id = ?'
    ).bind(orgId).first();
    return jsonResponse(config || { provider: 'oidc', issuer_url: '', client_id: '', redirect_uri: '', enabled: 0 });
  }

  // PUT /api/business/org/:id/sso — Configure SSO
  if (path.match(/^\/api\/business\/org\/[^/]+\/sso$/) && request.method === 'PUT') {
    const orgId = path.split('/')[4];
    const adminCheck = await requireOrgAdmin(env, orgId, session.userId);
    if (adminCheck) return adminCheck;

    const body = await request.json() as {
      provider?: string;
      issuer_url: string;
      client_id: string;
      client_secret: string;
      redirect_uri: string;
      enabled?: boolean;
    };

    if (!body.issuer_url || !body.client_id || !body.client_secret || !body.redirect_uri) {
      return errorResponse('Missing required SSO fields', 400);
    }

    // Validate issuer URL format
    try {
      new URL(body.issuer_url);
    } catch {
      return errorResponse('Invalid issuer URL', 400);
    }

    const provider = body.provider === 'saml' ? 'saml' : 'oidc';

    await env.DB.prepare(`
      INSERT OR REPLACE INTO sso_configs (org_id, provider, issuer_url, client_id, client_secret, redirect_uri, enabled, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, unixepoch())
    `).bind(orgId, provider, body.issuer_url, body.client_id, body.client_secret, body.redirect_uri, body.enabled ? 1 : 0).run();

    return jsonResponse({ ok: true });
  }

  // DELETE /api/business/org/:id/sso — Remove SSO config
  if (path.match(/^\/api\/business\/org\/[^/]+\/sso$/) && request.method === 'DELETE') {
    const orgId = path.split('/')[4];
    const adminCheck = await requireOrgAdmin(env, orgId, session.userId);
    if (adminCheck) return adminCheck;

    await env.DB.prepare('DELETE FROM sso_configs WHERE org_id = ?').bind(orgId).run();
    return jsonResponse({ ok: true });
  }

  // GET /api/business/org/:id/sso/login — Initiate SSO login (redirect to OIDC provider)
  if (path.match(/^\/api\/business\/org\/[^/]+\/sso\/login$/) && request.method === 'GET') {
    const orgId = path.split('/')[4];
    const config = await env.DB.prepare(
      'SELECT provider, issuer_url, client_id, redirect_uri, enabled FROM sso_configs WHERE org_id = ?'
    ).bind(orgId).first<{ provider: string; issuer_url: string; client_id: string; redirect_uri: string; enabled: number }>();

    if (!config || !config.enabled) {
      return errorResponse('SSO not configured or disabled', 400);
    }

    // Generate state parameter for CSRF protection
    const state = crypto.randomUUID();
    await env.KV.put(`sso_state:${state}`, JSON.stringify({ org_id: orgId, user_id: session.userId }), { expirationTtl: 300 });

    if (config.provider === 'oidc') {
      const authUrl = new URL(`${config.issuer_url}${config.issuer_url.endsWith('/') ? '' : '/'}authorize`);
      authUrl.searchParams.set('response_type', 'code');
      authUrl.searchParams.set('client_id', config.client_id);
      authUrl.searchParams.set('redirect_uri', config.redirect_uri);
      authUrl.searchParams.set('scope', 'openid email profile');
      authUrl.searchParams.set('state', state);
      return jsonResponse({ redirect_url: authUrl.toString(), state });
    }

    // SAML: return IdP login URL (simplified)
    const samlUrl = `${config.issuer_url}?SAMLRequest=${encodeURIComponent(state)}`;
    return jsonResponse({ redirect_url: samlUrl, state });
  }

  // POST /api/business/sso/callback — Handle OIDC callback (token exchange)
  if (path === '/api/business/sso/callback' && request.method === 'POST') {
    const body = await request.json() as { code: string; state: string };

    if (!body.code || !body.state) {
      return errorResponse('Missing code or state', 400);
    }

    // Verify state
    const stateData = await env.KV.get(`sso_state:${body.state}`);
    if (!stateData) return errorResponse('Invalid or expired state', 400);
    await env.KV.delete(`sso_state:${body.state}`);

    const { org_id } = JSON.parse(stateData) as { org_id: string; user_id: string };

    const config = await env.DB.prepare(
      'SELECT issuer_url, client_id, client_secret, redirect_uri FROM sso_configs WHERE org_id = ?'
    ).bind(org_id).first<{ issuer_url: string; client_id: string; client_secret: string; redirect_uri: string }>();

    if (!config) return errorResponse('SSO not configured', 400);

    // Exchange code for tokens
    const tokenUrl = `${config.issuer_url}${config.issuer_url.endsWith('/') ? '' : '/'}token`;
    const tokenResp = await fetch(tokenUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        code: body.code,
        redirect_uri: config.redirect_uri,
        client_id: config.client_id,
        client_secret: config.client_secret,
      }).toString(),
    });

    if (!tokenResp.ok) {
      return errorResponse('Token exchange failed', 502);
    }

    const tokens = await tokenResp.json() as { id_token?: string; access_token?: string; email?: string };

    // Decode and verify ID token via JWKS
    let email = '';
    if (tokens.id_token) {
      try {
        const [headerB64, payloadB64, sigB64] = tokens.id_token.split('.');
        const header = JSON.parse(atob(headerB64.replace(/-/g, '+').replace(/_/g, '/')));
        const payload = JSON.parse(atob(payloadB64.replace(/-/g, '+').replace(/_/g, '/')));

        // Fetch JWKS from issuer and verify signature
        const jwksUrl = `${config.issuer_url}${config.issuer_url.endsWith('/') ? '' : '/'}/.well-known/jwks.json`;
        const jwksResp = await fetch(jwksUrl);
        if (jwksResp.ok) {
          const jwks = await jwksResp.json() as { keys: Array<{ kid?: string; kty: string; alg?: string; n?: string; e?: string; crv?: string; x?: string; y?: string }> };
          const matchingKey = jwks.keys.find(k => k.kid === header.kid) || jwks.keys[0];
          if (matchingKey && matchingKey.kty === 'RSA' && matchingKey.n && matchingKey.e) {
            const b64url = (s: string) => Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/')), c => c.charCodeAt(0));
            const publicKey = await crypto.subtle.importKey(
              'jwk',
              { kty: 'RSA', n: matchingKey.n, e: matchingKey.e, alg: header.alg || 'RS256', ext: true },
              { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
              false,
              ['verify'],
            );
            const sigBytes = b64url(sigB64);
            const dataBytes = new TextEncoder().encode(`${headerB64}.${payloadB64}`);
            const valid = await crypto.subtle.verify('RSASSA-PKCS1-v1_5', publicKey, sigBytes, dataBytes);
            if (!valid) {
              return errorResponse('SSO token signature verification failed', 401);
            }
          }
        }

        // Verify standard claims
        const now = Math.floor(Date.now() / 1000);
        if (payload.exp && payload.exp < now) {
          return errorResponse('SSO token expired', 401);
        }
        if (payload.iss && !config.issuer_url.startsWith(payload.iss)) {
          return errorResponse('SSO token issuer mismatch', 401);
        }

        email = payload.email || payload.sub || '';
      } catch (e) {
        return errorResponse('Invalid SSO token', 401);
      }
    }

    return jsonResponse({
      ok: true,
      org_id,
      sso_email: email,
      access_token: tokens.access_token,
    });
  }

  // ── Bulk User Provisioning ──

  // POST /api/business/org/:id/members/bulk — Add multiple members at once
  if (path.match(/^\/api\/business\/org\/[^/]+\/members\/bulk$/) && request.method === 'POST') {
    const orgId = path.split('/')[4];
    const adminCheck = await requireOrgAdmin(env, orgId, session.userId);
    if (adminCheck) return adminCheck;

    const body = await request.json() as { users: { username: string; role?: string }[] };
    if (!Array.isArray(body.users) || body.users.length === 0) {
      return errorResponse('Provide a non-empty users array', 400);
    }
    if (body.users.length > 200) {
      return errorResponse('Maximum 200 users per bulk operation', 400);
    }

    const validRoles = ['member', 'moderator', 'admin'];
    const results: { username: string; status: string; user_id?: string }[] = [];

    for (const entry of body.users) {
      const role = entry.role && validRoles.includes(entry.role) ? entry.role : 'member';
      const user = await env.DB.prepare('SELECT id FROM users WHERE username = ?')
        .bind(entry.username).first<{ id: string }>();

      if (!user) {
        results.push({ username: entry.username, status: 'not_found' });
        continue;
      }

      // Check if already a member
      const existing = await env.DB.prepare(
        'SELECT user_id FROM organization_members WHERE org_id = ? AND user_id = ?'
      ).bind(orgId, user.id).first();

      if (existing) {
        results.push({ username: entry.username, status: 'already_member', user_id: user.id });
        continue;
      }

      await env.DB.prepare(
        'INSERT INTO organization_members (org_id, user_id, role) VALUES (?, ?, ?)'
      ).bind(orgId, user.id, role).run();

      results.push({ username: entry.username, status: 'added', user_id: user.id });
    }

    const added = results.filter(r => r.status === 'added').length;
    return jsonResponse({ ok: true, added, total: body.users.length, results });
  }

  // ── Organization Directory ──

  // GET /api/business/org/:id/directory — Search members in org
  if (path.match(/^\/api\/business\/org\/[^/]+\/directory$/) && request.method === 'GET') {
    const orgId = path.split('/')[4];
    const adminCheck = await requireOrgAdmin(env, orgId, session.userId);
    if (adminCheck) return adminCheck;

    const q = (url.searchParams.get('q') || '').trim().toLowerCase();
    let query: string;
    let params: unknown[];
    if (q) {
      query = `
        SELECT om.user_id, om.role, om.joined_at, u.username, u.display_name, u.avatar_url
        FROM organization_members om
        JOIN users u ON u.id = om.user_id
        WHERE om.org_id = ? AND (LOWER(u.username) LIKE ? OR LOWER(u.display_name) LIKE ?)
        ORDER BY u.display_name, u.username
        LIMIT 50
      `;
      params = [orgId, `%${q}%`, `%${q}%`];
    } else {
      query = `
        SELECT om.user_id, om.role, om.joined_at, u.username, u.display_name, u.avatar_url
        FROM organization_members om
        JOIN users u ON u.id = om.user_id
        WHERE om.org_id = ?
        ORDER BY u.display_name, u.username
        LIMIT 100
      `;
      params = [orgId];
    }
    const stmt = env.DB.prepare(query);
    const results = await stmt.bind(...params).all();
    return jsonResponse(results.results);
  }

  // ── API Keys / Webhooks ──

  // GET /api/business/org/:id/api-keys — List API keys
  if (path.match(/^\/api\/business\/org\/[^/]+\/api-keys$/) && request.method === 'GET') {
    const orgId = path.split('/')[4];
    const adminCheck = await requireOrgAdmin(env, orgId, session.userId);
    if (adminCheck) return adminCheck;

    const keys = await env.DB.prepare(
      `SELECT id, name, key_prefix, scopes, created_at, last_used_at FROM api_keys WHERE org_id = ? ORDER BY created_at DESC`
    ).bind(orgId).all();
    return jsonResponse(keys.results);
  }

  // POST /api/business/org/:id/api-keys — Create API key
  if (path.match(/^\/api\/business\/org\/[^/]+\/api-keys$/) && request.method === 'POST') {
    const orgId = path.split('/')[4];
    const adminCheck = await requireOrgAdmin(env, orgId, session.userId);
    if (adminCheck) return adminCheck;

    const body = await request.json() as Record<string, unknown>;
    const name = (body.name as string || '').trim();
    if (!name) return errorResponse('Key name required', 400);
    const scopes = JSON.stringify(body.scopes || ['read']);

    // Generate a secure random key
    const rawKey = Array.from(crypto.getRandomValues(new Uint8Array(32)))
      .map(b => b.toString(16).padStart(2, '0')).join('');
    const apiKey = `rck_${rawKey}`;
    const keyHash = await hashApiKey(apiKey);
    const keyId = crypto.randomUUID();

    await env.DB.prepare(
      `INSERT INTO api_keys (id, org_id, name, key_hash, key_prefix, scopes, created_by) VALUES (?, ?, ?, ?, ?, ?, ?)`
    ).bind(keyId, orgId, name, keyHash, apiKey.slice(0, 10), scopes, session.userId).run();

    // Return full key only once
    return jsonResponse({ id: keyId, name, key: apiKey, key_prefix: apiKey.slice(0, 10) });
  }

  // DELETE /api/business/org/:id/api-keys/:keyId — Revoke API key
  if (path.match(/^\/api\/business\/org\/[^/]+\/api-keys\/[^/]+$/) && request.method === 'DELETE') {
    const parts = path.split('/');
    const orgId = parts[4];
    const keyId = parts[6];
    const adminCheck = await requireOrgAdmin(env, orgId, session.userId);
    if (adminCheck) return adminCheck;

    await env.DB.prepare(`DELETE FROM api_keys WHERE id = ? AND org_id = ?`).bind(keyId, orgId).run();
    return jsonResponse({ ok: true });
  }

  // GET /api/business/org/:id/webhooks — List webhooks
  if (path.match(/^\/api\/business\/org\/[^/]+\/webhooks$/) && request.method === 'GET') {
    const orgId = path.split('/')[4];
    const adminCheck = await requireOrgAdmin(env, orgId, session.userId);
    if (adminCheck) return adminCheck;

    const hooks = await env.DB.prepare(
      `SELECT id, url, events, created_at, last_delivery_at, last_status FROM webhooks WHERE org_id = ? ORDER BY created_at DESC`
    ).bind(orgId).all();
    return jsonResponse(hooks.results);
  }

  // POST /api/business/org/:id/webhooks — Register webhook
  if (path.match(/^\/api\/business\/org\/[^/]+\/webhooks$/) && request.method === 'POST') {
    const orgId = path.split('/')[4];
    const adminCheck = await requireOrgAdmin(env, orgId, session.userId);
    if (adminCheck) return adminCheck;

    const body = await request.json() as Record<string, unknown>;
    const webhookUrl = (body.url as string || '').trim();
    // Validate URL (must be HTTPS)
    if (!webhookUrl.startsWith('https://')) return errorResponse('Webhook URL must use HTTPS', 400);
    const events = JSON.stringify(body.events || ['message.sent', 'member.added', 'member.removed']);
    const hookId = crypto.randomUUID();
    // Generate signing secret
    const signingSecret = `whsec_${Array.from(crypto.getRandomValues(new Uint8Array(24))).map(b => b.toString(16).padStart(2, '0')).join('')}`;

    await env.DB.prepare(
      `INSERT INTO webhooks (id, org_id, url, events, signing_secret, created_by) VALUES (?, ?, ?, ?, ?, ?)`
    ).bind(hookId, orgId, webhookUrl, events, signingSecret, session.userId).run();

    return jsonResponse({ id: hookId, url: webhookUrl, signing_secret: signingSecret });
  }

  // DELETE /api/business/org/:id/webhooks/:hookId — Remove webhook
  if (path.match(/^\/api\/business\/org\/[^/]+\/webhooks\/[^/]+$/) && request.method === 'DELETE') {
    const parts = path.split('/');
    const orgId = parts[4];
    const hookId = parts[6];
    const adminCheck = await requireOrgAdmin(env, orgId, session.userId);
    if (adminCheck) return adminCheck;

    await env.DB.prepare(`DELETE FROM webhooks WHERE id = ? AND org_id = ?`).bind(hookId, orgId).run();
    return jsonResponse({ ok: true });
  }

  return errorResponse('Not found', 404);
}

async function hashApiKey(key: string): Promise<string> {
  const data = new TextEncoder().encode(key);
  const hash = await crypto.subtle.digest('SHA-256', data);
  return Array.from(new Uint8Array(hash)).map(b => b.toString(16).padStart(2, '0')).join('');
}
