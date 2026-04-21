/**
 * Roc Client (canary channel)
 * --------------------------------------------------------------------------
 * A tiny opt-in surface that lets users join the experimental release
 * channel. When `enabled` is true the global `window.__rocChannel` flag
 * becomes 'roc' and feature-flag callsites can read it to gate new UI.
 *
 * Branding:
 *   - product name string : "Roc Client"
 *   - icon                : /roc-client-icon.svg (the roc bird mark)
 *
 * Server contract:
 *   GET  /api/canary  -> { enabled: boolean, channel: 'stable' | 'roc' }
 *   POST /api/canary  -> { ok: true, enabled }
 *
 * The canary flag is per-user, persisted in KV server-side, AND mirrored
 * to localStorage so cold loads can bias UI before the network call
 * resolves. The localStorage value is treated as a hint only — the
 * server response is always authoritative.
 */

import { req } from '../api.js';
import { parseHTML } from '../utils.js';

const STORAGE_KEY = 'rocchat_channel';
const ICON_PATH = '/roc-client-icon.svg';

export type ReleaseChannel = 'stable' | 'roc';

declare global {
  interface Window {
    __rocChannel?: ReleaseChannel;
  }
}

export function getChannel(): ReleaseChannel {
  if (typeof window === 'undefined') return 'stable';
  if (window.__rocChannel) return window.__rocChannel;
  const cached = localStorage.getItem(STORAGE_KEY);
  return cached === 'roc' ? 'roc' : 'stable';
}

export function isRocClient(): boolean {
  return getChannel() === 'roc';
}

export function getProductName(): string {
  return isRocClient() ? 'Roc Client' : 'RocChat';
}

export function getProductIcon(): string {
  return isRocClient() ? ICON_PATH : '/favicon.svg';
}

/**
 * Pull authoritative state from the server. Updates localStorage and
 * window.__rocChannel. Returns the resolved channel.
 */
export async function syncChannel(): Promise<ReleaseChannel> {
  try {
    const res = await req<{ enabled: boolean; channel: ReleaseChannel }>('/canary');
    if (res.ok) {
      const channel: ReleaseChannel = res.data.enabled ? 'roc' : 'stable';
      window.__rocChannel = channel;
      localStorage.setItem(STORAGE_KEY, channel);
      applyBranding(channel);
      return channel;
    }
  } catch {
    /* offline — keep cached value */
  }
  const cached = getChannel();
  applyBranding(cached);
  return cached;
}

/**
 * Toggle membership in the Roc Client channel.
 */
export async function setRocClientEnabled(enabled: boolean): Promise<boolean> {
  const res = await req<{ ok: boolean; enabled: boolean }>('/canary', {
    method: 'POST',
    body: JSON.stringify({ enabled }),
  });
  if (!res.ok) return false;
  const channel: ReleaseChannel = enabled ? 'roc' : 'stable';
  window.__rocChannel = channel;
  localStorage.setItem(STORAGE_KEY, channel);
  applyBranding(channel);
  return true;
}

/**
 * Update the document title, favicon, and the data-channel attribute
 * on <html> so CSS can theme based on the active channel.
 */
function applyBranding(channel: ReleaseChannel) {
  document.documentElement.setAttribute('data-channel', channel);
  if (channel === 'roc') {
    // Update favicon to the roc bird mark.
    const link = document.querySelector<HTMLLinkElement>('link[rel="icon"]');
    if (link) link.href = ICON_PATH;
    // Tag the document title with a small marker so users always know
    // they're on the canary channel.
    if (!document.title.includes('Roc Client')) {
      const base = document.title.replace(/\s*·\s*Roc Client$/, '');
      document.title = `${base} · Roc Client`;
    }
  } else {
    const link = document.querySelector<HTMLLinkElement>('link[rel="icon"]');
    if (link && link.href.endsWith(ICON_PATH)) link.href = '/favicon.svg';
    document.title = document.title.replace(/\s*·\s*Roc Client$/, '');
  }
}

/**
 * Render a small inline control suitable for embedding in Settings.
 */
export function renderRocClientToggle(container: HTMLElement) {
  const wrapper = document.createElement('section');
  wrapper.className = 'roc-client-toggle';
  wrapper.replaceChildren(parseHTML(`
    <div class="roc-client-card">
      <img src="${ICON_PATH}" alt="" width="48" height="48" class="roc-client-mark" />
      <div class="roc-client-copy">
        <h3>Roc Client</h3>
        <p>
          Opt into the canary channel to try new UI and protocol features
          first. Changes ship here for a few days before the stable build.
          You can leave any time.
        </p>
        <label class="roc-client-switch">
          <input type="checkbox" id="roc-client-toggle-input" />
          <span>Enable Roc Client</span>
        </label>
        <p class="roc-client-hint" id="roc-client-toggle-hint" aria-live="polite"></p>
      </div>
    </div>
  `));
  container.appendChild(wrapper);

  const input = wrapper.querySelector<HTMLInputElement>('#roc-client-toggle-input')!;
  const hint = wrapper.querySelector<HTMLParagraphElement>('#roc-client-toggle-hint')!;
  input.checked = isRocClient();
  hint.textContent = input.checked
    ? 'You are on the Roc Client channel.'
    : 'You are on the stable channel.';

  input.addEventListener('change', async () => {
    input.disabled = true;
    hint.textContent = 'Updating…';
    const ok = await setRocClientEnabled(input.checked);
    input.disabled = false;
    if (!ok) {
      input.checked = !input.checked;
      hint.textContent = 'Could not update channel. Check your connection and retry.';
      return;
    }
    hint.textContent = input.checked
      ? 'You are on the Roc Client channel.'
      : 'You are on the stable channel.';
  });
}
