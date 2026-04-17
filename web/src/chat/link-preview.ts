/**
 * RocChat Web — Link Preview Rendering
 *
 * Detects URLs in plaintext messages, fetches preview metadata via the
 * backend unfurler (which caches in KV for 24h), and renders a compact
 * card beneath the message bubble. Results are cached per-session in
 * memory to avoid re-fetching when the message list re-renders.
 */

import * as api from '../api.js';

const memCache = new Map<string, api.LinkPreview | null>();
const inflight = new Map<string, Promise<api.LinkPreview | null>>();

const URL_RE = /\bhttps?:\/\/[^\s<>"']+/gi;

export function extractFirstUrl(text: string): string | null {
  const m = text.match(URL_RE);
  return m ? m[0] : null;
}

export async function fetchPreview(url: string): Promise<api.LinkPreview | null> {
  if (memCache.has(url)) return memCache.get(url) ?? null;
  const existing = inflight.get(url);
  if (existing) return existing;
  const p = (async () => {
    try {
      const r = await api.getLinkPreview(url);
      const data = r.ok ? r.data : null;
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
    ? `<img class="lp-image" src="${esc(preview.image)}" alt="" loading="lazy" referrerpolicy="no-referrer" />`
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
  wrap.innerHTML = renderPreviewCard(preview);
  const card = wrap.firstElementChild;
  if (card) bubble.appendChild(card);
}
