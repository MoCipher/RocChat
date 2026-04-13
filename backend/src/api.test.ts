import { describe, it, expect } from 'vitest';

const API = 'https://rocchat-api.spoass.workers.dev';

describe('Backend API — Health & Public Routes', () => {
  it('GET /api/health returns ok', async () => {
    const res = await fetch(`${API}/api/health`);
    expect(res.status).toBe(200);
    const body = await res.json() as { status: string; service: string };
    expect(body.status).toBe('ok');
    expect(body.service).toBe('rocchat-api');
  });

  it('returns CORS headers', async () => {
    const res = await fetch(`${API}/api/health`, {
      method: 'OPTIONS',
    });
    const headers = res.headers;
    expect(headers.get('access-control-allow-origin')).toBeTruthy();
  });

  it('POST /api/auth/login requires body', async () => {
    const res = await fetch(`${API}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });
    // Should fail but not 500
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(res.status).toBeLessThan(500);
  });

  it('POST /api/auth/register requires body', async () => {
    const res = await fetch(`${API}/api/auth/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(res.status).toBeLessThan(500);
  });

  it('protected routes return 401 without token', async () => {
    const routes = ['/api/me', '/api/contacts', '/api/messages', '/api/keys/bundle', '/api/devices'];
    for (const route of routes) {
      const res = await fetch(`${API}${route}`);
      expect(res.status).toBe(401);
    }
  });

  it('unknown routes return 401 (auth wall)', async () => {
    const res = await fetch(`${API}/api/nonexistent`);
    expect(res.status).toBe(401);
  });
});
