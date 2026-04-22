/**
 * RocChat Web — Main App Entry Point
 *
 * Routes: Landing → QR Login / Manual Auth → Main App (Chats / Calls / Settings).
 * Per spec: 3 tabs only. No stories, channels, bots.
 *
 * Part of the Roc Family ecosystem — no third-party dependencies.
 */

// Self-hosted fonts (fontsource — no Google Fonts)
import '@fontsource/montserrat/400.css';
import { parseHTML } from './utils.js';
import '@fontsource/montserrat/500.css';
import '@fontsource/montserrat/600.css';
import '@fontsource/montserrat/700.css';
import '@fontsource/jetbrains-mono/400.css';
import '@fontsource/jetbrains-mono/500.css';

// Self-hosted Lucide icons (npm — no CDN)
import { createIcons, Search, Edit, Pencil, ShieldCheck, Trash2, Phone, PhoneOff, Mic, MicOff, Video, VideoOff } from 'lucide';
const lucideIcons = { Search, Edit, Pencil, ShieldCheck, Trash2, Phone, PhoneOff, Mic, MicOff, Video, VideoOff };
(window as any).lucide = { createIcons: (opts?: any) => createIcons({ icons: lucideIcons, ...opts }) };

import { renderLanding } from './landing/landing.js';
import { renderQrLogin } from './auth/qr-login.js';
import { renderAuth } from './auth/auth.js';
import { renderSidebar, type Tab } from './components/sidebar.js';
import { renderChats } from './chat/chat.js';
import { renderCalls } from './calls/calls.js';
import { renderChannels } from './channels/channels.js';
import { renderSettings, applyTheme, checkAppLock, showAppLockScreen } from './components/settings.js';
import { getToken, getPreKeyCount, uploadPreKeys, getMe, registerPushToken, getTransparencyReports, getSupportersWall } from './api.js';
import { migrateLegacySecrets, pruneOldDrafts } from './crypto/secure-store.js';
import { installCommandPaletteHotkey, registerPaletteCommand } from './components/cmdk.js';
import { syncChannel, setRocClientEnabled, isRocClient } from './components/roc-client.js';

// ── Trusted Types policy (defense-in-depth) ──
// CSP enforces `require-trusted-types-for 'script'`.
// createHTML is required because DOMParser.parseFromString IS a Trusted Types
// sink in browsers that enforce TT (Chrome, Firefox with the header). We allow
// it here because all callers pass developer-controlled template strings — never
// raw user input.
try {
  const tt = (window as unknown as { trustedTypes?: { createPolicy: (name: string, rules: object) => unknown; defaultPolicy?: unknown } }).trustedTypes;
  if (tt && typeof tt.createPolicy === 'function') {
    if (!tt.defaultPolicy) {
      tt.createPolicy('default', {
        createHTML: (s: string) => s,
        createScript: () => {
          throw new TypeError('Dynamic script text is blocked by Trusted Types policy');
        },
        createScriptURL: (s: string) => {
          const url = new URL(s, window.location.origin);
          if ((url.protocol !== 'https:' && url.protocol !== 'http:') || url.origin !== window.location.origin) {
            throw new TypeError('Cross-origin script URL blocked by Trusted Types policy');
          }
          return url.toString();
        },
      });
    }
  }
} catch { /* trustedTypes unavailable */ }

// SW queue replay requests auth at replay time; never persist bearer tokens in IDB.
if ('serviceWorker' in navigator) {
  navigator.serviceWorker.addEventListener('message', (event: MessageEvent<{ type?: string }>) => {
    if (event.data?.type !== 'rocchat:get-auth-token') return;
    const port = event.ports?.[0];
    if (!port) return;
    try {
      port.postMessage({ token: getToken() ?? null });
    } catch { /* ignore */ }
  });
}

let currentTab: Tab = 'chats';

// ── Error boundary & client error reporter ──
const ERROR_REPORT_URL = '/api/client-errors';
const errorQueue: { message: string; source?: string; line?: number; col?: number; stack?: string; ts: number }[] = [];
let errorFlushTimer: ReturnType<typeof setTimeout> | null = null;

function flushErrors() {
  if (!errorQueue.length) return;
  const batch = errorQueue.splice(0, 20);
  const token = getToken();
  if (!token) return;
  navigator.sendBeacon?.(ERROR_REPORT_URL, JSON.stringify({ errors: batch, token }));
}

window.addEventListener('error', (e) => {
  errorQueue.push({ message: e.message, source: e.filename, line: e.lineno, col: e.colno, stack: e.error?.stack, ts: Date.now() });
  if (!errorFlushTimer) errorFlushTimer = setTimeout(() => { errorFlushTimer = null; flushErrors(); }, 5000);
});
window.addEventListener('unhandledrejection', (e) => {
  const msg = e.reason instanceof Error ? e.reason.message : String(e.reason);
  const stack = e.reason instanceof Error ? e.reason.stack : undefined;
  errorQueue.push({ message: msg, stack, ts: Date.now() });
  if (!errorFlushTimer) errorFlushTimer = setTimeout(() => { errorFlushTimer = null; flushErrors(); }, 5000);
});

async function init() {
  try {
    // Migrate any legacy secrets from localStorage to encrypted IDB
    migrateLegacySecrets().catch(e => console.warn('Secret migration failed:', e));

    // Install command palette hotkey (⌘K / Ctrl+K)
    installCommandPaletteHotkey();

    // Garbage-collect drafts older than 30 days (best-effort, non-blocking)
    pruneOldDrafts().catch(() => { /* ignore IDB errors on first boot */ });

    // Pull authoritative Roc Client (canary) channel state. Non-blocking;
    // if the user is unauthenticated this no-ops on the server side.
    syncChannel().catch(() => { /* offline; cached value already applied */ });

    // Apply saved theme
    const savedTheme = localStorage.getItem('rocchat_theme') || 'auto';
    applyTheme(savedTheme);

    // Apply saved font scale
    const savedFontScale = parseFloat(localStorage.getItem('rocchat_font_scale') || '1');
    if (!isNaN(savedFontScale)) document.documentElement.style.setProperty('--roc-font-scale', String(savedFontScale));

    // App Lock — check before showing any UI
    if (!(await checkAppLock())) {
      dismissSplash();
      await showAppLockScreen(() => initAfterUnlock());
      return;
    }

    initAfterUnlock();
  } catch (err) {
    console.error('RocChat init failed:', err);
    // Always dismiss splash so the page is never permanently blank
    dismissSplash();
    // Fall back to landing page so users can still interact
    try { showLanding(); } catch { /* last resort */ }
  }
}

const splashShownAt = Date.now();
function dismissSplash() {
  const el = document.getElementById('loading-screen');
  if (!el) return;
  const elapsed = Date.now() - splashShownAt;
  const minDisplay = 800;
  const delay = Math.max(0, minDisplay - elapsed);
  setTimeout(() => {
    el.classList.add('fade-out');
    el.addEventListener('transitionend', () => el.remove(), { once: true });
    // Fallback if transitionend doesn't fire
    setTimeout(() => el.remove(), 600);
  }, delay);
}

function initAfterUnlock() {

  // Initialize PWA install prompts (iOS explainer + Chromium deferred prompt).
  import('./pwa-install.js').then((m) => m.initInstallPrompts()).catch(() => {});

  // Hide loading screen with smooth fade
  dismissSplash();

  // Check for Roc Bird status route (legacy #/canary is still supported)
  if (location.hash === '#/roc-bird' || location.hash === '#/canary') {
    showCanary();
    return;
  }
  if (location.hash === '#/transparency') {
    showTransparency();
    return;
  }
  if (location.hash === '#/supporters') {
    showSupportersWall();
    return;
  }

  const token = getToken();

  if (!token) {
    // Show landing page
    showLanding();
    return;
  }

  // Authenticated — render app
  renderApp();
  checkPreKeyReplenishment();
  cacheUserProfile();
  bootstrapVapidKey().then(() => registerWebPush());
  showOnboardingIfNeeded();

  // Listen for REFILL_KEYS signal from SW (triggered by periodic sync)
  navigator.serviceWorker?.addEventListener('message', (evt: MessageEvent<{ type?: string; remaining?: number }>) => {
    if (evt.data?.type === 'REFILL_KEYS') {
      checkPreKeyReplenishment();
    }
  });

  // SW update toast — inform user when a new version is waiting
  if ('serviceWorker' in navigator) {
    // If the active SW changes (because a waiting one took over via SKIP_WAITING),
    // reload once so clients pick up the new bundle without a stale tab.
    let reloadingForSw = false;
    navigator.serviceWorker.addEventListener('controllerchange', () => {
      if (reloadingForSw) return;
      reloadingForSw = true;
      window.location.reload();
    });
    navigator.serviceWorker.ready.then((reg) => {
      reg.addEventListener('updatefound', () => {
        const newSW = reg.installing;
        if (!newSW) return;
        newSW.addEventListener('statechange', () => {
          if (newSW.state === 'installed' && navigator.serviceWorker.controller) {
            showSwUpdateToast(newSW);
          }
        });
      });
    });
    // Register periodic sync for pre-key replenishment (Chrome/Android)
    navigator.serviceWorker.ready.then(async (reg) => {
      try {
        const ps = (reg as unknown as { periodicSync?: { register: (tag: string, opts: object) => Promise<void> } }).periodicSync;
        if (ps) await ps.register('refill-prekeys', { minInterval: 24 * 60 * 60 * 1000 });
      } catch { /* periodic sync not supported */ }
    });
  }

  // ── Command palette commands (lazy-registered, idempotent) ──
  registerPaletteCommand({ id: 'tab.chats',    label: 'Go to Chats',    shortcut: '⌘1', action: () => { currentTab = 'chats';    renderApp(); } });
  registerPaletteCommand({ id: 'tab.calls',    label: 'Go to Calls',    shortcut: '⌘2', action: () => { currentTab = 'calls';    renderApp(); } });
  registerPaletteCommand({ id: 'tab.channels', label: 'Go to Channels', shortcut: '⌘3', action: () => { currentTab = 'channels'; renderApp(); } });
  registerPaletteCommand({ id: 'tab.settings', label: 'Go to Settings', shortcut: '⌘,', action: () => { currentTab = 'settings'; renderApp(); } });
  registerPaletteCommand({ id: 'app.roc-bird', label: 'View Roc Bird Status', action: () => { location.hash = '#/roc-bird'; location.reload(); } });
  registerPaletteCommand({ id: 'app.transparency', label: 'View Transparency Reports', action: () => { location.hash = '#/transparency'; location.reload(); } });
  registerPaletteCommand({ id: 'app.status',   label: 'Open Status Page', action: () => { window.open('/status.html', '_blank', 'noopener,noreferrer'); } });
  registerPaletteCommand({ id: 'app.lock',     label: 'Lock app',  action: async () => {
    try {
      const mod = await import('./components/settings.js');
      await mod.showAppLockScreen(() => location.reload());
    } catch { location.reload(); }
  } });
  registerPaletteCommand({
    id: 'app.roc-client.toggle',
    label: 'Toggle Roc Client channel',
    hint: 'Opt in/out of experimental builds',
    action: async () => {
      const next = !isRocClient();
      const ok = await setRocClientEnabled(next);
      if (!ok) alert('Could not update channel.');
    },
  });

  // Numeric tab shortcuts
  window.addEventListener('keydown', (e) => {
    if (!(e.metaKey || e.ctrlKey) || e.shiftKey || e.altKey) return;
    const target = e.target as HTMLElement | null;
    if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable)) return;
    const key = e.key;
    if (key === '1') { e.preventDefault(); currentTab = 'chats';    renderApp(); }
    else if (key === '2') { e.preventDefault(); currentTab = 'calls';    renderApp(); }
    else if (key === '3') { e.preventDefault(); currentTab = 'channels'; renderApp(); }
    else if (key === ',') { e.preventDefault(); currentTab = 'settings'; renderApp(); }
  });

  // '?' shortcut — show keyboard shortcut cheatsheet
  window.addEventListener('keydown', (e) => {
    if (e.key !== '?' || e.metaKey || e.ctrlKey || e.altKey) return;
    const target = e.target as HTMLElement | null;
    if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable)) return;
    e.preventDefault();
    showShortcutCheatsheet();
  });

  // Handle ?action= URL parameters for PWA share/open-file targets
  const searchParams = new URLSearchParams(window.location.search);
  const urlAction = searchParams.get('action');
  if (urlAction === 'open-file') handleOpenFileAction();
  else if (urlAction === 'share') handleShareAction();
}

function showLanding() {
  const app = document.getElementById('app')!;
  app.replaceChildren();
  renderLanding(app, showQrLogin);
}

function showQrLogin() {
  const app = document.getElementById('app')!;
  app.replaceChildren();
  renderQrLogin(app, () => renderApp(), showLanding);
}

function renderApp() {
  const app = document.getElementById('app')!;
  app.replaceChildren(parseHTML(`
    <div class="app-layout">
      <div id="sidebar-container"></div>
      <div id="main-content" tabindex="-1" style="display:flex;flex:1;min-width:0;outline:none"></div>
    </div>
  `));

  renderSidebar(
    document.getElementById('sidebar-container')!,
    currentTab,
    (tab) => {
      currentTab = tab;
      renderApp();
    },
    0,
  );

  const main = document.getElementById('main-content')!;

  switch (currentTab) {
    case 'chats':
      renderChats(main);
      break;
    case 'calls':
      renderCalls(main);
      break;
    case 'channels':
      renderChannels(main);
      break;
    case 'settings':
      renderSettings(main);
      break;
  }

  // Focus management: move focus to main content after route change
  requestAnimationFrame(() => {
    const heading = main.querySelector('h1, h2, h3, [tabindex="-1"]') as HTMLElement;
    if (heading) { heading.setAttribute('tabindex', '-1'); heading.focus({ preventScroll: true }); }
    else main.focus({ preventScroll: true });
  });
}

const PRE_KEY_THRESHOLD = 5;

async function cacheUserProfile() {
  try {
    const res = await getMe();
    if (!res.ok) return;
    const u = res.data as unknown as Record<string, unknown>;
    if (u.display_name) localStorage.setItem('rocchat_display_name', u.display_name as string);
    else if (u.username) localStorage.setItem('rocchat_display_name', u.username as string);
    if (u.avatar_url) localStorage.setItem('rocchat_avatar_url', u.avatar_url as string);
    else localStorage.removeItem('rocchat_avatar_url');
    // Re-render sidebar to show avatar
    const sc = document.getElementById('sidebar-container');
    if (sc) renderSidebar(sc, currentTab, (tab) => { currentTab = tab; renderApp(); }, 0);
  } catch { /* silent */ }
}

async function checkPreKeyReplenishment() {
  try {
    const res = await getPreKeyCount();
    if (!res.ok) return;
    const count = (res.data as { count: number }).count;
    if (count < PRE_KEY_THRESHOLD) {
      const { generateX25519KeyPair, toBase64 } = await import('@rocchat/shared');
      const newKeys: { id: number; publicKey: string }[] = [];
      const baseId = Date.now();
      for (let i = 0; i < 20; i++) {
        const kp = await generateX25519KeyPair();
        newKeys.push({ id: baseId + i, publicKey: toBase64(kp.publicKey) });
      }
      await uploadPreKeys(newKeys);
    }
  } catch { /* silently fail — will retry on next app load */ }
}

// Fetch VAPID public key from backend and cache it
async function bootstrapVapidKey(): Promise<void> {
  if (localStorage.getItem('rocchat_vapid_public')) return;
  try {
    const res = await fetch('/api/push/vapid-key');
    const data = await res.json() as { vapid_public_key?: string };
    if (data.vapid_public_key) localStorage.setItem('rocchat_vapid_public', data.vapid_public_key);
  } catch { /* VAPID key not available */ }
}

// Web Push registration (only call when user explicitly opts in via Settings).
// Older builds auto-prompted on load — that's a hostile UX pattern and also
// wastes a user's one-shot permission chance before they know what the app is.
async function registerWebPush(options: { prompt?: boolean } = {}) {
  if (!('serviceWorker' in navigator) || !('PushManager' in window)) return;
  try {
    const reg = await navigator.serviceWorker.ready;
    let sub = await reg.pushManager.getSubscription();
    if (!sub) {
      // Only prompt when the caller explicitly asks (i.e. user clicked "Enable
      // notifications" in Settings). Background init reuses existing subs only.
      if (Notification.permission !== 'granted') {
        if (!options.prompt) return;
        const perm = await Notification.requestPermission();
        if (perm !== 'granted') return;
      }
      const vapidKey = localStorage.getItem('rocchat_vapid_public');
      if (!vapidKey) return;
      sub = await reg.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: urlBase64ToUint8Array(vapidKey) as BufferSource,
      });
    }
    await registerPushToken(JSON.stringify(sub.toJSON()), 'web');
  } catch { /* push not available */ }
}

// Expose to settings for the "Enable notifications" button.
(window as unknown as { __rocchatEnablePush?: () => Promise<void> }).__rocchatEnablePush =
  () => registerWebPush({ prompt: true });

function urlBase64ToUint8Array(base64String: string): Uint8Array {
  const padding = '='.repeat((4 - base64String.length % 4) % 4);
  const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/');
  const rawData = atob(base64);
  const arr = new Uint8Array(rawData.length);
  for (let i = 0; i < rawData.length; i++) arr[i] = rawData.charCodeAt(i);
  return arr;
}

async function showCanary() {
  const app = document.getElementById('app')!;
  app.replaceChildren(parseHTML(`
    <div style="max-width:640px;margin:40px auto;padding:24px;font-family:var(--font-sans,system-ui)">
      <div style="text-align:center;margin-bottom:32px">
        <div style="font-size:48px;margin-bottom:8px">🐦</div>
        <h1 style="font-size:28px;font-weight:bold;color:var(--roc-gold,#D4AF37);margin:0">RocChat Roc Bird Status</h1>
      </div>
      <div id="canary-content" style="border:1px solid var(--border-primary,#333);border-radius:12px;padding:24px;background:var(--bg-secondary,#1a1a2e)">
        <p style="color:var(--text-secondary,#aaa)">Loading Roc Bird status...</p>
      </div>
      <div style="text-align:center;margin-top:24px">
        <a href="#/" style="color:var(--roc-gold,#D4AF37);text-decoration:none" onclick="location.hash='';location.reload()">← Back to RocChat</a>
      </div>
    </div>
  `));
  try {
    const resp = await fetch('/api/features/canary');
    const data = await resp.json();
    const content = document.getElementById('canary-content')!;
    const statusColor = data.status === 'clear' ? '#40E0D0' : '#ef4444';
    const statusIcon = data.status === 'clear' ? '✅' : '⚠️';
    content.replaceChildren(parseHTML(`
      <div style="display:flex;align-items:center;gap:12px;margin-bottom:20px">
        <span style="font-size:24px">${statusIcon}</span>
        <div>
          <div style="font-weight:bold;font-size:18px;color:${statusColor};text-transform:uppercase">${data.status}</div>
          <div style="font-size:12px;color:var(--text-tertiary,#888)">Last updated: ${new Date(data.last_updated).toLocaleDateString()}</div>
        </div>
      </div>
      <p style="line-height:1.7;color:var(--text-primary,#eee);font-size:14px">${data.statement}</p>
      <div style="margin-top:20px;padding-top:16px;border-top:1px solid var(--border-primary,#333);display:flex;justify-content:space-between;font-size:12px;color:var(--text-tertiary,#888)">
        <span>Next update: ${new Date(data.next_update).toLocaleDateString()}</span>
        <span>Signed by: ${data.signed_by}</span>
      </div>
    `));
  } catch {
    document.getElementById('canary-content')!.replaceChildren(parseHTML('<p style="color:#ef4444">Failed to load Roc Bird status.</p>'));
  }
}

async function showTransparency() {
  const app = document.getElementById('app')!;
  app.replaceChildren(parseHTML(`
    <div style="max-width:760px;margin:40px auto;padding:24px;font-family:var(--font-sans,system-ui)">
      <div style="text-align:center;margin-bottom:24px">
        <div style="font-size:40px;margin-bottom:8px">📜</div>
        <h1 style="font-size:28px;font-weight:bold;color:var(--roc-gold,#D4AF37);margin:0">RocChat Transparency Reports</h1>
      </div>
      <div id="transparency-content" style="display:flex;flex-direction:column;gap:12px">
        <div style="border:1px solid var(--border-primary,#333);border-radius:12px;padding:20px;background:var(--bg-secondary,#1a1a2e);color:var(--text-secondary,#aaa)">Loading reports...</div>
      </div>
      <div style="text-align:center;margin-top:24px">
        <a href="#/" style="color:var(--roc-gold,#D4AF37);text-decoration:none" onclick="location.hash='';location.reload()">← Back to RocChat</a>
      </div>
    </div>
  `));

  try {
    const res = await getTransparencyReports();
    const reports = res.ok ? res.data.reports : [];
    const content = document.getElementById('transparency-content')!;
    if (!reports.length) {
      content.replaceChildren(parseHTML('<div style="border:1px solid var(--border-primary,#333);border-radius:12px;padding:20px;background:var(--bg-secondary,#1a1a2e);color:var(--text-secondary,#aaa)">No transparency reports published yet.</div>'));
      return;
    }
    content.replaceChildren(parseHTML(reports.map((r) => `
      <div style="border:1px solid var(--border-primary,#333);border-radius:12px;padding:20px;background:var(--bg-secondary,#1a1a2e)">
        <div style="display:flex;justify-content:space-between;gap:12px;align-items:center;margin-bottom:12px;flex-wrap:wrap">
          <strong style="color:var(--text-primary,#eee)">${new Date(r.period_start * 1000).toLocaleDateString()} - ${new Date(r.period_end * 1000).toLocaleDateString()}</strong>
          <span style="font-size:12px;color:var(--text-tertiary,#888)">Published ${new Date(r.published_at * 1000).toLocaleDateString()}</span>
        </div>
        <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(180px,1fr));gap:10px;font-size:13px;margin-bottom:10px">
          <div><span style="color:var(--text-tertiary,#888)">Requests Received</span><br><strong style="color:var(--text-primary,#eee)">${r.requests_received}</strong></div>
          <div><span style="color:var(--text-tertiary,#888)">Requests Complied</span><br><strong style="color:var(--text-primary,#eee)">${r.requests_complied}</strong></div>
          <div><span style="color:var(--text-tertiary,#888)">Accounts Affected</span><br><strong style="color:var(--text-primary,#eee)">${r.accounts_affected}</strong></div>
        </div>
        ${r.notes ? `<p style="margin:0;color:var(--text-secondary,#aaa);font-size:13px;line-height:1.5">${r.notes}</p>` : ''}
        <div style="margin-top:12px;font-size:12px;color:var(--text-tertiary,#888)">Signed by: ${r.signed_by}</div>
      </div>
    `).join('')));
  } catch {
    document.getElementById('transparency-content')!.replaceChildren(parseHTML('<div style="border:1px solid var(--border-primary,#333);border-radius:12px;padding:20px;background:var(--bg-secondary,#1a1a2e);color:#ef4444">Failed to load transparency reports.</div>'));
  }
}

async function showSupportersWall() {
  const app = document.getElementById('app')!;
  app.replaceChildren(parseHTML(`
    <div style="max-width:900px;margin:40px auto;padding:24px;font-family:var(--font-sans,system-ui)">
      <div style="text-align:center;margin-bottom:24px">
        <div style="font-size:40px;margin-bottom:8px">🪶</div>
        <h1 style="font-size:28px;font-weight:bold;color:var(--roc-gold,#D4AF37);margin:0">Supporters Wall</h1>
        <p style="font-size:13px;color:var(--text-tertiary,#888)">Thank you to everyone helping keep RocChat free.</p>
      </div>
      <div id="supporters-content" style="display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:12px">
        <div style="border:1px solid var(--border-primary,#333);border-radius:12px;padding:20px;background:var(--bg-secondary,#1a1a2e);color:var(--text-secondary,#aaa)">Loading supporters...</div>
      </div>
      <div style="text-align:center;margin-top:24px">
        <a href="#/" style="color:var(--roc-gold,#D4AF37);text-decoration:none" onclick="location.hash='';location.reload()">← Back to RocChat</a>
      </div>
    </div>
  `));
  try {
    const res = await getSupportersWall();
    const supporters = res.ok ? res.data.supporters : [];
    const content = document.getElementById('supporters-content')!;
    if (!supporters.length) {
      content.replaceChildren(parseHTML('<div style="border:1px solid var(--border-primary,#333);border-radius:12px;padding:20px;background:var(--bg-secondary,#1a1a2e);color:var(--text-secondary,#aaa)">No supporters listed yet.</div>'));
      return;
    }
    content.replaceChildren(parseHTML(supporters.map((s) => {
      const tier = (s.donor_tier || 'supporter').toUpperCase();
      const recurring = s.donor_recurring ? ' · Recurring' : '';
      const since = s.donor_since ? `Since ${new Date(s.donor_since * 1000).toLocaleDateString()}` : '';
      return `
        <div style="border:1px solid var(--border-primary,#333);border-radius:12px;padding:16px;background:var(--bg-secondary,#1a1a2e)">
          <div style="font-weight:700;color:var(--text-primary,#eee)">${s.display_name || s.username}</div>
          <div style="font-size:12px;color:var(--text-tertiary,#888)">@${s.username}</div>
          <div style="margin-top:8px;font-size:13px;color:var(--roc-gold,#D4AF37)">${tier}${recurring}</div>
          ${since ? `<div style="margin-top:4px;font-size:12px;color:var(--text-tertiary,#888)">${since}</div>` : ''}
        </div>
      `;
    }).join('')));
  } catch {
    document.getElementById('supporters-content')!.replaceChildren(parseHTML('<div style="border:1px solid var(--border-primary,#333);border-radius:12px;padding:20px;background:var(--bg-secondary,#1a1a2e);color:#ef4444">Failed to load supporters wall.</div>'));
  }
}

function showOnboardingIfNeeded() {
  if (localStorage.getItem('rocchat_onboarded')) return;
  const overlay = document.createElement('div');
  overlay.className = 'rc-dialog-overlay';

  function renderStep(step: number) {
    if (step === 1) {
      overlay.replaceChildren(parseHTML(`
        <div class="rc-dialog" style="max-width:440px">
          <div style="text-align:center;padding:var(--sp-6)">
            <div style="font-size:56px;margin-bottom:var(--sp-4)">🔒</div>
            <h2 style="margin:0 0 var(--sp-2);font-size:var(--text-xl);color:var(--roc-gold,#D4AF37)">Welcome to RocChat</h2>
            <p style="color:var(--text-secondary);font-size:var(--text-sm);line-height:1.6;margin:0 0 var(--sp-4)">
              Every message is <strong>end-to-end encrypted</strong> using the Double Ratchet protocol.
              Nobody — not even RocChat — can read your messages.
            </p>
            <div style="text-align:left;background:var(--surface-primary);border-radius:12px;padding:var(--sp-4);margin-bottom:var(--sp-4)">
              <div style="margin-bottom:var(--sp-3);font-size:var(--text-sm)">
                <strong style="color:var(--turquoise,#40E0D0)">🔑 Safety Numbers</strong><br/>
                <span style="color:var(--text-tertiary)">Verify your contact's identity to prevent impersonation.</span>
              </div>
              <div style="margin-bottom:var(--sp-3);font-size:var(--text-sm)">
                <strong style="color:var(--turquoise,#40E0D0)">💨 Disappearing Messages</strong><br/>
                <span style="color:var(--text-tertiary)">Set timers so messages auto-delete after reading.</span>
              </div>
              <div style="font-size:var(--text-sm)">
                <strong style="color:var(--turquoise,#40E0D0)">📱 Multi-Device</strong><br/>
                <span style="color:var(--text-tertiary)">Scan QR codes to link devices securely.</span>
              </div>
            </div>
            <div style="display:flex;gap:var(--sp-2)">
              <button class="btn btn-primary" style="flex:1" id="onboard-next">Next →</button>
            </div>
            <div style="margin-top:var(--sp-3);display:flex;justify-content:center;gap:6px">
              <div style="width:8px;height:8px;border-radius:50%;background:var(--roc-gold,#D4AF37)"></div>
              <div style="width:8px;height:8px;border-radius:50%;background:var(--border-norm)"></div>
              <div style="width:8px;height:8px;border-radius:50%;background:var(--border-norm)"></div>
            </div>
          </div>
        </div>`));
      overlay.querySelector('#onboard-next')?.addEventListener('click', () => renderStep(2));
    } else if (step === 2) {
      // Recovery phrase reminder
      overlay.replaceChildren(parseHTML(`
        <div class="rc-dialog" style="max-width:440px">
          <div style="text-align:center;padding:var(--sp-6)">
            <div style="font-size:56px;margin-bottom:var(--sp-4)">🗝️</div>
            <h2 style="margin:0 0 var(--sp-2);font-size:var(--text-xl);color:var(--roc-gold,#D4AF37)">Back Up Your Keys</h2>
            <p style="color:var(--text-secondary);font-size:var(--text-sm);line-height:1.6;margin:0 0 var(--sp-4)">
              Your encryption keys are stored only on your device. If you lose access, your messages cannot be recovered without a backup.
            </p>
            <div style="background:rgba(212,175,55,0.08);border:1px solid rgba(212,175,55,0.3);border-radius:12px;padding:var(--sp-4);margin-bottom:var(--sp-4);text-align:left">
              <div style="font-size:var(--text-sm);margin-bottom:var(--sp-2)">
                <strong style="color:var(--roc-gold,#D4AF37)">⚠️ Zero-knowledge means zero recovery</strong>
              </div>
              <ul style="margin:0;padding-left:var(--sp-4);color:var(--text-secondary);font-size:var(--text-sm);line-height:1.7">
                <li>Export your key backup in <strong>Settings → Privacy → Export Keys</strong></li>
                <li>Store it in a password manager or encrypted drive</li>
                <li>Never share your passphrase with anyone</li>
              </ul>
            </div>
            <div style="display:flex;gap:var(--sp-2)">
              <button class="btn btn-secondary" style="flex:1" id="onboard-skip-backup">Remind me later</button>
              <button class="btn btn-primary" style="flex:1" id="onboard-backup-next">I understand →</button>
            </div>
            <div style="margin-top:var(--sp-3);display:flex;justify-content:center;gap:6px">
              <div style="width:8px;height:8px;border-radius:50%;background:var(--border-norm)"></div>
              <div style="width:8px;height:8px;border-radius:50%;background:var(--roc-gold,#D4AF37)"></div>
              <div style="width:8px;height:8px;border-radius:50%;background:var(--border-norm)"></div>
            </div>
          </div>
        </div>`));
      overlay.querySelector('#onboard-backup-next')?.addEventListener('click', () => renderStep(3));
      overlay.querySelector('#onboard-skip-backup')?.addEventListener('click', () => renderStep(3));
    } else {
      overlay.replaceChildren(parseHTML(`
        <div class="rc-dialog" style="max-width:440px">
          <div style="text-align:center;padding:var(--sp-6)">
            <div style="font-size:56px;margin-bottom:var(--sp-4)">📥</div>
            <h2 style="margin:0 0 var(--sp-2);font-size:var(--text-xl);color:var(--roc-gold,#D4AF37)">Import Your Chats</h2>
            <p style="color:var(--text-secondary);font-size:var(--text-sm);line-height:1.6;margin:0 0 var(--sp-4)">
              Switching from another app? Drop your export file here to bring your conversations with you.
            </p>
            <div id="onboard-dropzone" style="border:2px dashed var(--border-norm);border-radius:12px;padding:var(--sp-6);cursor:pointer;margin-bottom:var(--sp-4);transition:border-color 0.2s,background 0.2s">
              <div style="font-size:32px;margin-bottom:var(--sp-2)">📂</div>
              <div style="font-size:var(--text-sm);color:var(--text-secondary)">Drop WhatsApp, Telegram, or Signal export</div>
              <div style="font-size:var(--text-xs);color:var(--text-tertiary);margin-top:var(--sp-1)">.txt or .json files supported</div>
            </div>
            <input type="file" id="onboard-file-input" accept=".txt,.json,.zip" style="display:none">
            <div id="onboard-import-status" style="font-size:var(--text-xs);color:var(--text-tertiary);margin-bottom:var(--sp-3);min-height:20px"></div>
            <div style="display:flex;gap:var(--sp-2)">
              <button class="btn btn-secondary" style="flex:1" id="onboard-skip">Skip for now</button>
              <button class="btn btn-primary" style="flex:1" id="onboard-done">Get Started</button>
            </div>
            <div style="margin-top:var(--sp-3);display:flex;justify-content:center;gap:6px">
              <div style="width:8px;height:8px;border-radius:50%;background:var(--border-norm)"></div>              <div style="width:8px;height:8px;border-radius:50%;background:var(--border-norm)"></div>              <div style="width:8px;height:8px;border-radius:50%;background:var(--roc-gold,#D4AF37)"></div>
            </div>
          </div>
        </div>`));

      const dropzone = overlay.querySelector('#onboard-dropzone') as HTMLElement;
      const fileInput = overlay.querySelector('#onboard-file-input') as HTMLInputElement;
      const status = overlay.querySelector('#onboard-import-status') as HTMLElement;

      const dismiss = () => { localStorage.setItem('rocchat_onboarded', '1'); overlay.remove(); };
      overlay.querySelector('#onboard-skip')?.addEventListener('click', dismiss);
      overlay.querySelector('#onboard-done')?.addEventListener('click', dismiss);

      dropzone?.addEventListener('click', () => fileInput?.click());
      dropzone?.addEventListener('dragover', (e) => {
        e.preventDefault();
        dropzone.style.borderColor = 'var(--roc-gold,#D4AF37)';
        dropzone.style.background = 'rgba(212,175,55,0.05)';
      });
      dropzone?.addEventListener('dragleave', () => {
        dropzone.style.borderColor = 'var(--border-norm)';
        dropzone.style.background = '';
      });
      dropzone?.addEventListener('drop', (e) => {
        e.preventDefault();
        dropzone.style.borderColor = 'var(--border-norm)';
        dropzone.style.background = '';
        const file = (e as DragEvent).dataTransfer?.files[0];
        if (file) { status.textContent = `Selected: ${file.name} — go to Settings > Import to finish`; }
      });
      fileInput?.addEventListener('change', () => {
        const file = fileInput.files?.[0];
        if (file) { status.textContent = `Selected: ${file.name} — go to Settings > Import to finish`; }
      });
    }
  }

  document.body.appendChild(overlay);
  renderStep(1);

  overlay.addEventListener('click', (e) => {
    if (e.target === overlay) {
      localStorage.setItem('rocchat_onboarded', '1');
      overlay.remove();
    }
  });
}

/** Show a dismissable toast when a new SW is waiting to activate. */
function showSwUpdateToast(waitingSW?: ServiceWorker) {
  if (document.getElementById('sw-update-toast')) return;
  const toast = document.createElement('div');
  toast.id = 'sw-update-toast';
  toast.setAttribute('role', 'alert');
  toast.style.cssText = 'position:fixed;bottom:80px;left:50%;transform:translateX(-50%);z-index:9999;background:var(--bg-elevated,#1C1814);border:1px solid var(--roc-gold,#D4AF37);border-radius:12px;padding:12px 20px;display:flex;align-items:center;gap:12px;box-shadow:var(--shadow-lg);font-size:13px;color:var(--text-primary,#E8E2D4);white-space:nowrap';
  toast.replaceChildren(parseHTML(`
    <span>🔄 A new version is available.</span>
    <button id="sw-reload-btn" style="background:var(--roc-gold,#D4AF37);color:#000;border:none;border-radius:6px;padding:4px 12px;font-size:12px;font-weight:600;cursor:pointer">Reload</button>
    <button id="sw-dismiss-btn" style="background:none;border:none;color:var(--text-tertiary);font-size:16px;cursor:pointer;line-height:1" aria-label="Dismiss">✕</button>
  `));
  document.body.appendChild(toast);
  toast.querySelector('#sw-reload-btn')?.addEventListener('click', () => {
    // Ask the waiting SW to activate; the controllerchange listener above will
    // reload the page once it takes control. Fall back to a plain reload if we
    // don't have a handle on the waiting worker (shouldn't happen in practice).
    const sw = waitingSW ?? navigator.serviceWorker.controller;
    if (sw) {
      try { sw.postMessage({ type: 'SKIP_WAITING' }); } catch { /* ignore */ }
      // Safety net: if controllerchange never fires (e.g. user has another tab
      // keeping the old SW alive), reload after a short grace period anyway.
      setTimeout(() => window.location.reload(), 1500);
    } else {
      window.location.reload();
    }
  });
  toast.querySelector('#sw-dismiss-btn')?.addEventListener('click', () => toast.remove());
  setTimeout(() => toast.remove(), 30000);
}

/** Handle ?action=open-file — open the "import" section of Settings */
function handleOpenFileAction() {
  currentTab = 'settings';
  renderApp();
  // After render, trigger the import flow if available
  const importBtn = document.querySelector('[data-settings-action="import"]') as HTMLElement | null;
  if (importBtn) importBtn.click();
}

/** Handle ?action=share — open a "share to contact" dialog. */
function handleShareAction() {
  const params = new URLSearchParams(window.location.search);
  const title = params.get('title') ?? '';
  const text = params.get('text') ?? '';
  const url = params.get('url') ?? '';
  const shared = [title, text, url].filter(Boolean).join('\n');
  if (!shared) return;
  // Store in sessionStorage so the chat composer can pick it up
  sessionStorage.setItem('rocchat_share_payload', shared);
  currentTab = 'chats';
  renderApp();
}

/** '?' keyboard shortcut — show a keyboard shortcut cheatsheet modal. */
function showShortcutCheatsheet() {
  const existing = document.getElementById('shortcut-cheatsheet-overlay');
  if (existing) { existing.remove(); return; }
  const overlay = document.createElement('div');
  overlay.id = 'shortcut-cheatsheet-overlay';
  overlay.className = 'rc-dialog-overlay';
  overlay.replaceChildren(parseHTML(`
    <div class="rc-dialog" style="max-width:480px" role="dialog" aria-modal="true" aria-label="Keyboard shortcuts">
      <div style="padding:var(--sp-6)">
        <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:var(--sp-4)">
          <h2 style="margin:0;font-size:var(--text-xl);color:var(--roc-gold,#D4AF37)">Keyboard Shortcuts</h2>
          <button id="cheatsheet-close" style="background:none;border:none;font-size:20px;color:var(--text-secondary);cursor:pointer" aria-label="Close">✕</button>
        </div>
        <div style="display:grid;gap:8px;font-size:var(--text-sm)">
          ${[
            ['⌘K', 'Open command palette'],
            ['⌘1', 'Go to Chats'],
            ['⌘2', 'Go to Calls'],
            ['⌘3', 'Go to Channels'],
            ['⌘,', 'Go to Settings'],
            ['?', 'Show this cheatsheet'],
            ['Esc', 'Close dialogs / deselect'],
          ].map(([key, desc]) => `
            <div style="display:flex;justify-content:space-between;align-items:center;padding:6px 0;border-bottom:1px solid var(--border-weak)">
              <span style="color:var(--text-secondary)">${desc}</span>
              <kbd style="background:var(--surface-primary);border:1px solid var(--border-norm);border-radius:4px;padding:2px 8px;font-family:var(--font-mono);font-size:12px;color:var(--roc-gold,#D4AF37)">${key}</kbd>
            </div>
          `).join('')}
        </div>
      </div>
    </div>
  `));
  document.body.appendChild(overlay);
  overlay.querySelector('#cheatsheet-close')?.addEventListener('click', () => overlay.remove());
  overlay.addEventListener('click', (e) => { if (e.target === overlay) overlay.remove(); });
  document.addEventListener('keydown', function escClose(e) {
    if (e.key === 'Escape') { overlay.remove(); document.removeEventListener('keydown', escClose); }
  }, { once: false });
}

// Boot
window.addEventListener('DOMContentLoaded', () => { void init(); });
