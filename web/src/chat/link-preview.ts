/**
 * RocChat Web — Link Preview Rendering
 *
 * Detects URLs in plaintext messages, fetches preview metadata, and
 * renders a compact card beneath the message bubble.
 *
 * Two modes (controlled by localStorage "rocchat_link_preview_mode"):
 *   "server"  (default) — Uses the backend unfurler (/api/link-preview).
 *                          Hides the user's IP from the target site, but
 *                          the RocChat server learns the URL.
 *   "client"            — Fetches directly from the client via a CORS
 *                          proxy-free <meta> scrape. The RocChat server
 *                          never sees the URL, but the target site sees
 *                          the user's IP.
 *   "disabled"          — No link previews at all (maximum privacy).
 */

import * as api from '../api.js';
import { parseHTML } from '../utils.js';

const memCache = new Map<string, api.LinkPreview | null>();
const inflight = new Map<string, Promise<api.LinkPreview | null>>();

const URL_RE = /\bhttps?:\/\/[^\s<>"']+/gi;

export type LinkPreviewMode = 'server' | 'client' | 'disabled';

export function getLinkPreviewMode(): LinkPreviewMode {
  const v = localStorage.getItem('rocchat_link_preview_mode');
  if (v === 'client' || v === 'disabled') return v;
  return 'server';
}

export function setLinkPreviewMode(mode: LinkPreviewMode): void {
  localStorage.setItem('rocchat_link_preview_mode', mode);
  memCache.clear();
}

export function extractFirstUrl(text: string): string | null {
  const m = text.match(URL_RE);
  return m ? m[0] : null;
}

async function fetchPreviewClient(url: string): Promise<api.LinkPreview | null> {
  try {
    const res = await fetch(url, {
      mode: 'cors',
      credentials: 'omit',
      headers: { 'Accept': 'text/html' },
      redirect: 'follow',
    });
    if (!res.ok) return null;
    const text = await res.text();
    const doc = new DOMParser().parseFromString(text, 'text/html');
    const og = (name: string) =>
      doc.querySelector(`meta[property="${name}"]`)?.getAttribute('content') ||
      doc.querySelector(`meta[name="${name}"]`)?.getAttribute('content') || '';
    const title = og('og:title') || doc.querySelector('title')?.textContent?.trim() || '';
    if (!title) return null;
    let host: string;
    try { host = new URL(url).hostname; } catch { host = ''; }
    return {
      url,
      title,
      description: og('og:description') || og('description'),
      image: og('og:image'),
      site_name: og('og:site_name') || host,
    };
  } catch {
    return null;
  }
}

export async function fetchPreview(url: string): Promise<api.LinkPreview | null> {
  const mode = getLinkPreviewMode();
  if (mode === 'disabled') return null;

  if (memCache.has(url)) return memCache.get(url) ?? null;
  const existing = inflight.get(url);
  if (existing) return existing;
  const p = (async () => {
    try {
      let data: api.LinkPreview | null;
      if (mode === 'client') {
        data = await fetchPreviewClient(url);
      } else {
        const r = await api.getLinkPreview(url);
        data = r.ok ? r.data : null;
      }
      memCache.set(url, data);
      return data;
    } catch {
      memCache.set(url, null);
      return null;
    } finally {
      inflight.delete(url);
    }
  })();
  inflight.set(url, p);
  return p;
}

export function renderPreviewCard(preview: api.LinkPreview): string {
  const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c] || c));
  const img = preview.image
    ? `<img class="lp-image" src="${esc(preview.image)}" alt="" loading="lazy" decoding="async" referrerpolicy="no-referrer" />`
    : '';
  return `
    <a class="link-preview" href="${esc(preview.url)}" target="_blank" rel="noopener noreferrer nofollow">
      ${img}
      <div class="lp-body">
        <div class="lp-site">${esc(preview.site_name)}</div>
        <div class="lp-title">${esc(preview.title)}</div>
        ${preview.description ? `<div class="lp-desc">${esc(preview.description)}</div>` : ''}
      </div>
    </a>`;
}

/**
 * Attach a preview to a rendered bubble, if the message contains a URL.
 * Safe to call repeatedly for the same message — it is a no-op when a
 * preview has already been attached.
 */
export async function attachPreviewIfAny(bubble: HTMLElement, plaintext: string): Promise<void> {
  if (bubble.querySelector('.link-preview')) return;
  const url = extractFirstUrl(plaintext);
  if (!url) return;
  const preview = await fetchPreview(url);
  if (!preview || bubble.querySelector('.link-preview')) return;
  const wrap = document.createElement('div');
  wrap.replaceChildren(parseHTML(renderPreviewCard(preview)));
  const card = wrap.firstElementChild;
  if (card) bubble.appendChild(card);
}
