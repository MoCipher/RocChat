/**
 * RocChat Web — Settings UI
 */

import * as api from '../api.js';

function showToast(message: string, type: 'success' | 'error' = 'success') {
  let container = document.getElementById('toast-container');
  if (!container) {
    container = document.createElement('div');
    container.id = 'toast-container';
    container.className = 'toast-container';
    container.setAttribute('role', 'alert');
    document.body.appendChild(container);
  }
  const toast = document.createElement('div');
  toast.className = `toast toast-${type}`;
  toast.textContent = message;
  container.appendChild(toast);
  setTimeout(() => { toast.classList.add('toast-exit'); setTimeout(() => toast.remove(), 300); }, 2500);
}

async function saveSetting(fn: () => Promise<unknown>) {
  try {
    await fn();
    showToast('Saved');
  } catch {
    showToast('Failed to save', 'error');
  }
}

export function renderSettings(container: HTMLElement) {
  container.innerHTML = `
    <div class="panel-list" style="width:100%;max-width:640px;border-right:none">
      <div class="panel-header">
        <h2>Settings</h2>
      </div>
      <div class="settings-view" id="settings-view">

        <div class="settings-section">
          <h3>Account</h3>
          <div class="setting-row">
            <div>
              <div class="setting-label" id="setting-username">@loading...</div>
              <div class="setting-desc">Your username</div>
            </div>
          </div>
          <div class="setting-row">
            <div>
              <div class="setting-label" id="setting-display-name">Loading...</div>
              <div class="setting-desc">Display name</div>
            </div>
            <button class="icon-btn" title="Edit" id="edit-name-btn">
              <i data-lucide="pencil" style="width:16px;height:16px"></i>
            </button>
          </div>
        </div>

        <div class="settings-section">
          <h3>Privacy</h3>
          <div class="setting-row">
            <div>
              <div class="setting-label">Discoverable by username</div>
              <div class="setting-desc">Allow others to find you by searching your username</div>
            </div>
            <label class="toggle">
              <input type="checkbox" id="toggle-discoverable" checked />
              <span class="toggle-slider"></span>
            </label>
          </div>
          <div class="setting-row">
            <div>
              <div class="setting-label">Read receipts</div>
              <div class="setting-desc">Show others when you've read their messages</div>
            </div>
            <label class="toggle">
              <input type="checkbox" id="toggle-receipts" checked />
              <span class="toggle-slider"></span>
            </label>
          </div>
          <div class="setting-row">
            <div>
              <div class="setting-label">Typing indicators</div>
              <div class="setting-desc">Show when you're typing</div>
            </div>
            <label class="toggle">
              <input type="checkbox" id="toggle-typing" checked />
              <span class="toggle-slider"></span>
            </label>
          </div>
          <div class="setting-row">
            <div>
              <div class="setting-label">Online status visible to</div>
              <div class="setting-desc">Who can see when you're online</div>
            </div>
            <select class="form-input" style="width:auto;padding:var(--sp-2) var(--sp-3)" id="online-visibility">
              <option value="everyone">Everyone</option>
              <option value="contacts">Contacts only</option>
              <option value="nobody">Nobody</option>
            </select>
          </div>
          <div class="setting-row">
            <div>
              <div class="setting-label">Who can add me</div>
              <div class="setting-desc">Control who can start a conversation with you</div>
            </div>
            <select class="form-input" style="width:auto;padding:var(--sp-2) var(--sp-3)" id="who-can-add">
              <option value="everyone">Everyone</option>
              <option value="nobody">Nobody</option>
            </select>
          </div>
        </div>

        <div class="settings-section">
          <h3>Disappearing Messages</h3>
          <div class="setting-row">
            <div>
              <div class="setting-label">Default timer for new chats</div>
              <div class="setting-desc">Messages will auto-delete after this time</div>
            </div>
            <select class="form-input" style="width:auto;padding:var(--sp-2) var(--sp-3)" id="default-disappear">
              <option value="0">Off</option>
              <option value="300">5 minutes</option>
              <option value="3600">1 hour</option>
              <option value="86400">24 hours</option>
              <option value="604800">7 days</option>
              <option value="2592000">30 days</option>
            </select>
          </div>
        </div>

        <div class="settings-section">
          <h3>Appearance</h3>
          <div class="setting-row">
            <div>
              <div class="setting-label">Theme</div>
              <div class="setting-desc">Choose your preferred color scheme</div>
            </div>
            <select class="form-input" style="width:auto;padding:var(--sp-2) var(--sp-3)" id="theme-select">
              <option value="auto">Auto</option>
              <option value="light">Light</option>
              <option value="dark">Dark</option>
            </select>
          </div>
        </div>

        <div class="settings-section">
          <h3>Encryption</h3>
          <div class="setting-row">
            <div>
              <div class="setting-label" style="color:var(--turquoise)">🔒 All communications are end-to-end encrypted</div>
              <div class="setting-desc">
                Using X25519 key exchange, AES-256-GCM encryption, Double Ratchet protocol.
                Zero third-party crypto libraries.
              </div>
            </div>
          </div>
          <div class="setting-row">
            <div>
              <div class="setting-label">Identity Key</div>
              <div class="setting-desc" id="identity-key-display" style="font-family:var(--font-mono);word-break:break-all">
                Loading...
              </div>
            </div>
          </div>
        </div>

        <div class="settings-section">
          <h3>Devices</h3>
          <div id="devices-list">
            <div class="skeleton-line" style="height:40px;margin-bottom:var(--sp-2)"></div>
            <div class="skeleton-line" style="height:40px;margin-bottom:var(--sp-2)"></div>
          </div>
        </div>

        <div class="settings-section">
          <h3>About</h3>
          <div class="setting-row">
            <div>
              <div class="setting-label">RocChat v0.1.0</div>
              <div class="setting-desc">Part of the Roc Family (RocMail · RocPass · RocChat)</div>
            </div>
          </div>
        </div>

        <div style="padding:var(--sp-4) 0">
          <button class="btn-secondary" id="logout-btn" style="color:var(--danger);border-color:var(--danger)">
            Sign Out
          </button>
        </div>
      </div>
    </div>
  `;

  // Load profile
  loadProfile();
  loadDevices();

  // Theme selector
  const themeSelect = document.getElementById('theme-select') as HTMLSelectElement;
  const savedTheme = localStorage.getItem('rocchat_theme') || 'auto';
  themeSelect.value = savedTheme;
  themeSelect.addEventListener('change', () => {
    const theme = themeSelect.value;
    localStorage.setItem('rocchat_theme', theme);
    applyTheme(theme);
  });

  // Discoverable toggle
  document.getElementById('toggle-discoverable')?.addEventListener('change', async (e) => {
    const checked = (e.target as HTMLInputElement).checked;
    await saveSetting(() => api.updateSettings({ discoverable: checked ? 1 : 0 }));
  });

  // Read receipts toggle
  document.getElementById('toggle-receipts')?.addEventListener('change', async (e) => {
    const checked = (e.target as HTMLInputElement).checked;
    await saveSetting(() => api.updateSettings({ show_read_receipts: checked ? 1 : 0 }));
  });

  // Typing indicators toggle
  document.getElementById('toggle-typing')?.addEventListener('change', async (e) => {
    const checked = (e.target as HTMLInputElement).checked;
    await saveSetting(() => api.updateSettings({ show_typing_indicator: checked ? 1 : 0 }));
  });

  // Online visibility
  document.getElementById('online-visibility')?.addEventListener('change', async (e) => {
    const value = (e.target as HTMLSelectElement).value;
    await saveSetting(() => api.updateSettings({ show_online_to: value }));
  });

  // Who can add
  document.getElementById('who-can-add')?.addEventListener('change', async (e) => {
    const value = (e.target as HTMLSelectElement).value;
    await saveSetting(() => api.updateSettings({ who_can_add: value }));
  });

  // Default disappearing timer
  document.getElementById('default-disappear')?.addEventListener('change', async (e) => {
    const value = parseInt((e.target as HTMLSelectElement).value, 10);
    await saveSetting(() => api.updateSettings({ default_disappear_timer: value || null }));
  });

  // Logout
  document.getElementById('logout-btn')?.addEventListener('click', () => {
    api.setToken(null);
    localStorage.removeItem('rocchat_user_id');
    localStorage.removeItem('rocchat_keys');
    localStorage.removeItem('rocchat_identity_pub');
    location.reload();
  });

  if (typeof (window as any).lucide !== 'undefined') {
    (window as any).lucide.createIcons();
  }
}

async function loadProfile() {
  try {
    const res = await api.getMe();
    if (res.ok) {
      const user = res.data as unknown as Record<string, unknown>;
      const usernameEl = document.getElementById('setting-username');
      const nameEl = document.getElementById('setting-display-name');
      const keyEl = document.getElementById('identity-key-display');
      const toggle = document.getElementById('toggle-discoverable') as HTMLInputElement;

      if (usernameEl) usernameEl.textContent = `@${user.username}`;
      if (nameEl) nameEl.textContent = (user.display_name as string) || (user.username as string);
      if (keyEl) keyEl.textContent = (user.identity_key as string) || 'Not available';
      if (toggle) toggle.checked = !!user.discoverable;

      // Privacy settings
      const receipts = document.getElementById('toggle-receipts') as HTMLInputElement;
      if (receipts) receipts.checked = user.show_read_receipts !== 0;
      const typing = document.getElementById('toggle-typing') as HTMLInputElement;
      if (typing) typing.checked = user.show_typing_indicator !== 0;
      const online = document.getElementById('online-visibility') as HTMLSelectElement;
      if (online && user.show_online_to) online.value = user.show_online_to as string;
      const whoAdd = document.getElementById('who-can-add') as HTMLSelectElement;
      if (whoAdd && user.who_can_add) whoAdd.value = user.who_can_add as string;
      const disappear = document.getElementById('default-disappear') as HTMLSelectElement;
      if (disappear) disappear.value = String(user.default_disappear_timer || 0);
    }
  } catch {}
}

export function applyTheme(theme: string) {
  const root = document.documentElement;
  root.classList.remove('dark', 'light');
  if (theme === 'dark') root.classList.add('dark');
  else if (theme === 'light') root.classList.add('light');
  // 'auto' = no class, handled by @media query
}

async function loadDevices() {
  const container = document.getElementById('devices-list');
  if (!container) return;
  try {
    const res = await api.getDevices();
    if (!res.ok) {
      container.innerHTML = '<p style="font-size:var(--text-sm);color:var(--text-tertiary)">Could not load devices.</p>';
      return;
    }
    const devices = res.data as unknown as Array<{ id: string; device_name: string; platform: string; last_active: number; created_at: number }>;
    if (!devices.length) {
      container.innerHTML = '<p style="font-size:var(--text-sm);color:var(--text-tertiary)">No devices.</p>';
      return;
    }
    container.innerHTML = devices.map((d) => {
      const icon = d.platform === 'ios' ? '📱' : d.platform === 'android' ? '📱' : '💻';
      const active = d.last_active ? new Date(d.last_active * 1000).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' }) : 'Unknown';
      return `
        <div class="setting-row" style="align-items:center">
          <div>
            <div class="setting-label">${icon} ${escHtml(d.device_name)}</div>
            <div class="setting-desc">${escHtml(d.platform)} · Last active: ${active}</div>
          </div>
          <button class="icon-btn device-remove-btn" data-device-id="${d.id}" title="Remove device" style="color:var(--danger)">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 6h18M19 6v14a2 2 0 01-2 2H7a2 2 0 01-2-2V6m3 0V4a2 2 0 012-2h4a2 2 0 012 2v2"/></svg>
          </button>
        </div>`;
    }).join('');

    container.querySelectorAll('.device-remove-btn').forEach((btn) => {
      btn.addEventListener('click', async () => {
        const deviceId = (btn as HTMLElement).dataset.deviceId;
        if (!deviceId || !confirm('Remove this device?')) return;
        const del = await api.deleteDevice(deviceId);
        if (del.ok) {
          showToast('Device removed');
          loadDevices();
        } else {
          showToast('Failed to remove device', 'error');
        }
      });
    });
  } catch {
    container.innerHTML = '<p style="font-size:var(--text-sm);color:var(--text-tertiary)">Could not load devices.</p>';
  }
}

function escHtml(s: string): string { const d = document.createElement('div'); d.textContent = s; return d.innerHTML; }
