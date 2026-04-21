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

// ── Trusted Types policy (defense-in-depth) ──
// We do not enforce via CSP yet (legacy innerHTML callsites exist), but
// declaring the policy lets us migrate sinks one by one.
try {
  const tt = (window as unknown as { trustedTypes?: { createPolicy: (name: string, rules: object) => unknown; defaultPolicy?: unknown } }).trustedTypes;
  if (tt && typeof tt.createPolicy === 'function') {
    // Default policy: pass-through but logged so migration callers can find it.
    if (!tt.defaultPolicy) {
      tt.createPolicy('rocchat-default', {
        createHTML: (s: string) => s,
        createScript: (s: string) => s,
        createScriptURL: (s: string) => s,
      });
    }
  }
} catch { /* trustedTypes unavailable */ }

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
  // Migrate any legacy secrets from localStorage to encrypted IDB
  migrateLegacySecrets().catch(e => console.warn('Secret migration failed:', e));

  // Install command palette hotkey (⌘K / Ctrl+K)
  installCommandPaletteHotkey();

  // Garbage-collect drafts older than 30 days (best-effort, non-blocking)
  pruneOldDrafts().catch(() => { /* ignore IDB errors on first boot */ });

  // Apply saved theme
  const savedTheme = localStorage.getItem('rocchat_theme') || 'auto';
  applyTheme(savedTheme);

  // App Lock — check before showing any UI
  if (!(await checkAppLock())) {
    const loading = document.getElementById('loading-screen');
    if (loading) loading.remove();
    await showAppLockScreen(() => initAfterUnlock());
    return;
  }

  initAfterUnlock();
}

function initAfterUnlock() {

  // Initialize PWA install prompts (iOS explainer + Chromium deferred prompt).
  import('./pwa-install.js').then((m) => m.initInstallPrompts()).catch(() => {});

  // Hide loading screen
  const loading = document.getElementById('loading-screen');
  if (loading) loading.remove();

  // Check for warrant canary route
  if (location.hash === '#/canary') {
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

  // ── Command palette commands (lazy-registered, idempotent) ──
  registerPaletteCommand({ id: 'tab.chats',    label: 'Go to Chats',    shortcut: '⌘1', action: () => { currentTab = 'chats';    renderApp(); } });
  registerPaletteCommand({ id: 'tab.calls',    label: 'Go to Calls',    shortcut: '⌘2', action: () => { currentTab = 'calls';    renderApp(); } });
  registerPaletteCommand({ id: 'tab.channels', label: 'Go to Channels', shortcut: '⌘3', action: () => { currentTab = 'channels'; renderApp(); } });
  registerPaletteCommand({ id: 'tab.settings', label: 'Go to Settings', shortcut: '⌘,', action: () => { currentTab = 'settings'; renderApp(); } });
  registerPaletteCommand({ id: 'app.canary',   label: 'View Warrant Canary', action: () => { location.hash = '#/canary'; location.reload(); } });
  registerPaletteCommand({ id: 'app.transparency', label: 'View Transparency Reports', action: () => { location.hash = '#/transparency'; location.reload(); } });
  registerPaletteCommand({ id: 'app.status',   label: 'Open Status Page', action: () => { window.open('/status.html', '_blank', 'noopener,noreferrer'); } });
  registerPaletteCommand({ id: 'app.lock',     label: 'Lock app',  action: async () => {
    try {
      const mod = await import('./components/settings.js');
      await mod.showAppLockScreen(() => location.reload());
    } catch { location.reload(); }
  } });

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
}

function showLanding() {
  const app = document.getElementById('app')!;
  app.innerHTML = '';
  renderLanding(app, showQrLogin);
}

function showQrLogin() {
  const app = document.getElementById('app')!;
  app.innerHTML = '';
  renderQrLogin(app, () => renderApp(), showLanding);
}

function renderApp() {
  const app = document.getElementById('app')!;
  app.innerHTML = `
    <div class="app-layout">
      <div id="sidebar-container"></div>
      <div id="main-content" tabindex="-1" style="display:flex;flex:1;min-width:0;outline:none"></div>
    </div>
  `;

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
  app.innerHTML = `
    <div style="max-width:640px;margin:40px auto;padding:24px;font-family:var(--font-sans,system-ui)">
      <div style="text-align:center;margin-bottom:32px">
        <div style="font-size:48px;margin-bottom:8px">🐦</div>
        <h1 style="font-size:28px;font-weight:bold;color:var(--roc-gold,#D4AF37);margin:0">RocChat Warrant Canary</h1>
      </div>
      <div id="canary-content" style="border:1px solid var(--border-primary,#333);border-radius:12px;padding:24px;background:var(--bg-secondary,#1a1a2e)">
        <p style="color:var(--text-secondary,#aaa)">Loading canary status...</p>
      </div>
      <div style="text-align:center;margin-top:24px">
        <a href="#/" style="color:var(--roc-gold,#D4AF37);text-decoration:none" onclick="location.hash='';location.reload()">← Back to RocChat</a>
      </div>
    </div>
  `;
  try {
    const resp = await fetch('/api/features/canary');
    const data = await resp.json();
    const content = document.getElementById('canary-content')!;
    const statusColor = data.status === 'clear' ? '#40E0D0' : '#ef4444';
    const statusIcon = data.status === 'clear' ? '✅' : '⚠️';
    content.innerHTML = `
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
    `;
  } catch {
    document.getElementById('canary-content')!.innerHTML = '<p style="color:#ef4444">Failed to load canary status.</p>';
  }
}

async function showTransparency() {
  const app = document.getElementById('app')!;
  app.innerHTML = `
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
  `;

  try {
    const res = await getTransparencyReports();
    const reports = res.ok ? res.data.reports : [];
    const content = document.getElementById('transparency-content')!;
    if (!reports.length) {
      content.innerHTML = '<div style="border:1px solid var(--border-primary,#333);border-radius:12px;padding:20px;background:var(--bg-secondary,#1a1a2e);color:var(--text-secondary,#aaa)">No transparency reports published yet.</div>';
      return;
    }
    content.innerHTML = reports.map((r) => `
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
    `).join('');
  } catch {
    document.getElementById('transparency-content')!.innerHTML = '<div style="border:1px solid var(--border-primary,#333);border-radius:12px;padding:20px;background:var(--bg-secondary,#1a1a2e);color:#ef4444">Failed to load transparency reports.</div>';
  }
}

async function showSupportersWall() {
  const app = document.getElementById('app')!;
  app.innerHTML = `
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
  `;
  try {
    const res = await getSupportersWall();
    const supporters = res.ok ? res.data.supporters : [];
    const content = document.getElementById('supporters-content')!;
    if (!supporters.length) {
      content.innerHTML = '<div style="border:1px solid var(--border-primary,#333);border-radius:12px;padding:20px;background:var(--bg-secondary,#1a1a2e);color:var(--text-secondary,#aaa)">No supporters listed yet.</div>';
      return;
    }
    content.innerHTML = supporters.map((s) => {
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
    }).join('');
  } catch {
    document.getElementById('supporters-content')!.innerHTML = '<div style="border:1px solid var(--border-primary,#333);border-radius:12px;padding:20px;background:var(--bg-secondary,#1a1a2e);color:#ef4444">Failed to load supporters wall.</div>';
  }
}

function showOnboardingIfNeeded() {
  if (localStorage.getItem('rocchat_onboarded')) return;
  const overlay = document.createElement('div');
  overlay.className = 'rc-dialog-overlay';

  function renderStep(step: number) {
    if (step === 1) {
      overlay.innerHTML = `
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
            </div>
          </div>
        </div>`;
      overlay.querySelector('#onboard-next')?.addEventListener('click', () => renderStep(2));
    } else {
      overlay.innerHTML = `
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
              <div style="width:8px;height:8px;border-radius:50%;background:var(--border-norm)"></div>
              <div style="width:8px;height:8px;border-radius:50%;background:var(--roc-gold,#D4AF37)"></div>
            </div>
          </div>
        </div>`;

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

// Boot
window.addEventListener('DOMContentLoaded', () => { void init(); });
