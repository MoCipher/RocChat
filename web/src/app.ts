/**
 * RocChat Web — Main App Entry Point
 *
 * Routes: Landing → QR Login / Manual Auth → Main App (Chats / Calls / Settings).
 * Per spec: 3 tabs only. No stories, channels, bots.
 */

import { renderLanding } from './landing/landing.js';
import { renderQrLogin } from './auth/qr-login.js';
import { renderAuth } from './auth/auth.js';
import { renderSidebar, type Tab } from './components/sidebar.js';
import { renderChats } from './chat/chat.js';
import { renderCalls } from './calls/calls.js';
import { renderSettings, applyTheme } from './components/settings.js';
import { getToken, getPreKeyCount, uploadPreKeys } from './api.js';

let currentTab: Tab = 'chats';

function init() {
  // Apply saved theme
  const savedTheme = localStorage.getItem('rocchat_theme') || 'auto';
  applyTheme(savedTheme);

  // Hide loading screen
  const loading = document.getElementById('loading-screen');
  if (loading) loading.remove();

  const token = getToken();

  if (!token) {
    // Show landing page
    showLanding();
    return;
  }

  // Authenticated — render app
  renderApp();
  checkPreKeyReplenishment();
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
      <div id="main-content" style="display:flex;flex:1;min-width:0"></div>
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
    case 'settings':
      renderSettings(main);
      break;
  }
}

const PRE_KEY_THRESHOLD = 5;

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

// Boot
window.addEventListener('DOMContentLoaded', () => {
  // Small delay to show loading animation
  setTimeout(init, 600);
});
