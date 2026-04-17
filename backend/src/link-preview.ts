/**
 * RocChat Backend — Link Preview (Open Graph unfurler)
 *
 * Fetches OG/Twitter meta tags from a URL server-side so the web client can
 * render rich link previews without leaking the user's IP / User-Agent to the
 * target site. Caches results in KV for 24 hours.
 *
 * Hardening:
 * - Only http(s) URLs allowed.
 * - 5 MB response cap (stream is cut at first 256 KiB for parsing).
 * - 5 s fetch timeout.
 * - Strips private / loopback / link-local / metadata IPs (SSRF defense).
 * - Drops cookies / auth headers.
 * - Rate-limited by caller via wrapping route.
 */

import type { Env } from './index.js';
import { jsonResponse, apiError } from './middleware.js';

const CACHE_TTL_SECONDS = 24 * 3600;
const MAX_BYTES = 256 * 1024; // 256 KiB is more than enough for a <head>

export async function handleLinkPreview(request: Request, env: Env, url: URL): Promise<Response> {
  if (request.method !== 'GET') return apiError('BAD_REQUEST', 'GET only');
  const target = url.searchParams.get('url');
  if (!target) return apiError('BAD_REQUEST', 'Missing url');

  // ── Basic URL validation ──
  let parsed: URL;
  try { parsed = new URL(target); } catch { return apiError('BAD_REQUEST', 'Bad url'); }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    return apiError('BAD_REQUEST', 'Only http(s) URLs allowed');
  }
  // Block SSRF: refuse hostnames that resolve to private/loopback ranges.
  // We do a string-level check; the runtime fetch cannot resolve DNS for us.
  const host = parsed.hostname.toLowerCase();
  if (isPrivateHost(host)) return apiError('BAD_REQUEST', 'Private hosts not allowed');

  // ── Cache lookup ──
  const cacheKey = `linkpreview:${await sha256Hex(parsed.toString())}`;
  const cached = await env.KV.get(cacheKey);
  if (cached) {
    return new Response(cached, {
      headers: { 'content-type': 'application/json', 'x-rc-cache': 'hit' },
    });
  }

  // ── Fetch with strict limits ──
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), 5000);
  let html = '';
  let finalUrl = parsed.toString();
  try {
    const res = await fetch(parsed.toString(), {
      method: 'GET',
      redirect: 'follow',
      headers: {
        // Generic UA; no cookies or referrer so origin stays private.
        'user-agent': 'RocChatLinkPreview/1.0 (+https://rocchat.app/link-preview)',
        'accept': 'text/html,application/xhtml+xml',
        'accept-language': 'en',
      },
      signal: ac.signal,
    });
    if (!res.ok || !res.body) {
      clearTimeout(timer);
      return apiError('NOT_FOUND', `Upstream ${res.status}`);
    }
    finalUrl = res.url;
    // Re-check the host after redirects — a redirect could land on a private IP.
    try {
      const redirHost = new URL(finalUrl).hostname.toLowerCase();
      if (isPrivateHost(redirHost)) {
        clearTimeout(timer);
        return apiError('BAD_REQUEST', 'Redirect to private host');
      }
    } catch { /* noop */ }

    // Stream up to MAX_BYTES.
    const reader = res.body.getReader();
    const chunks: Uint8Array[] = [];
    let total = 0;
    while (total < MAX_BYTES) {
      const { value, done } = await reader.read();
      if (done) break;
      if (value) {
        chunks.push(value);
        total += value.byteLength;
      }
    }
    try { await reader.cancel(); } catch { /* noop */ }
    const buf = new Uint8Array(total);
    let offset = 0;
    for (const c of chunks) { buf.set(c, offset); offset += c.byteLength; }
    html = new TextDecoder('utf-8', { fatal: false, ignoreBOM: true }).decode(buf);
  } catch {
    clearTimeout(timer);
    return apiError('NOT_FOUND', 'Fetch failed');
  }
  clearTimeout(timer);

  // ── Parse ──
  const meta = parseMeta(html);
  const preview = {
    url: finalUrl,
    title: meta.title || meta.ogTitle || host,
    description: meta.ogDescription || meta.description || '',
    image: absolutize(meta.ogImage, finalUrl),
    site_name: meta.ogSiteName || host,
  };

  const json = JSON.stringify(preview);
  // Don't `await` the cache write; it's fine if it fails.
  env.KV.put(cacheKey, json, { expirationTtl: CACHE_TTL_SECONDS }).catch(() => {});
  return new Response(json, {
    headers: { 'content-type': 'application/json', 'x-rc-cache': 'miss' },
  });
}

// ── Helpers ──

interface Meta {
  title?: string;
  description?: string;
  ogTitle?: string;
  ogDescription?: string;
  ogImage?: string;
  ogSiteName?: string;
}

function parseMeta(html: string): Meta {
  const out: Meta = {};
  // <title>...</title>
  const t = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  if (t) out.title = decodeEntities(t[1].trim()).slice(0, 300);

  // <meta ... />
  const metaRe = /<meta\s+([^>]+?)\/?\s*>/gi;
  let m: RegExpExecArray | null;
  while ((m = metaRe.exec(html)) !== null) {
    const attrs = m[1];
    const name = (attrs.match(/\b(?:name|property)\s*=\s*["']([^"']+)["']/i) || [])[1]?.toLowerCase();
    const content = (attrs.match(/\bcontent\s*=\s*["']([^"']*)["']/i) || [])[1];
    if (!name || content === undefined) continue;
    const v = decodeEntities(content).slice(0, 500);
    switch (name) {
      case 'description':      out.description   = v; break;
      case 'og:title':         out.ogTitle       = v; break;
      case 'og:description':   out.ogDescription = v; break;
      case 'og:image':
      case 'og:image:secure_url':
        if (!out.ogImage) out.ogImage = v;
        break;
      case 'og:site_name':     out.ogSiteName    = v; break;
      case 'twitter:title':    out.ogTitle     ||= v; break;
      case 'twitter:description': out.ogDescription ||= v; break;
      case 'twitter:image':    out.ogImage     ||= v; break;
    }
  }
  return out;
}

function decodeEntities(s: string): string {
  return s
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, d) => String.fromCharCode(parseInt(d, 10)))
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCharCode(parseInt(h, 16)));
}

function absolutize(maybeRelative: string | undefined, base: string): string {
  if (!maybeRelative) return '';
  try { return new URL(maybeRelative, base).toString(); } catch { return ''; }
}

function isPrivateHost(host: string): boolean {
  // Reject common private / loopback targets by string match. This is a
  // defense-in-depth; Cloudflare's fetch also refuses some of these.
  if (host === 'localhost' || host.endsWith('.localhost')) return true;
  if (host === '0.0.0.0' || host === '255.255.255.255') return true;
  // IPv4 literal → dotted quad
  const ipv4 = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (ipv4) {
    const [a, b] = [parseInt(ipv4[1], 10), parseInt(ipv4[2], 10)];
    if (a === 10) return true;
    if (a === 127) return true;
    if (a === 169 && b === 254) return true;  // link-local + AWS metadata
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 192 && b === 168) return true;
    if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT
    if (a === 0) return true;
  }
  // IPv6 literal
  if (host.startsWith('[')) {
    const inner = host.replace(/^\[|\]$/g, '').toLowerCase();
    if (inner === '::1' || inner === '::' || inner.startsWith('fc') || inner.startsWith('fd')) return true;
    if (inner.startsWith('fe80')) return true;
  }
  // Cloud metadata endpoints (covered by 169.254 but named too)
  if (host === 'metadata.google.internal') return true;
  return false;
}

async function sha256Hex(input: string): Promise<string> {
  const data = new TextEncoder().encode(input);
  const hash = await crypto.subtle.digest('SHA-256', data);
  return Array.from(new Uint8Array(hash)).map(b => b.toString(16).padStart(2, '0')).join('');
}
