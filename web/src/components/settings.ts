/**
 * RocChat Web — Settings UI
 */

import * as api from '../api.js';
import { generateQRCodeSVG } from '../auth/qr-login.js';
import { clearAllSecrets } from '../crypto/secure-store.js';
import { showToast } from './toast.js';

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
        <h2>Profile</h2>
      </div>
      <div class="settings-view" id="settings-view">

        <div class="settings-section profile-hero" style="padding:var(--sp-6) var(--sp-4);border-radius:20px;margin:var(--sp-3);position:relative;overflow:hidden;background:linear-gradient(135deg, rgba(212,175,55,0.22) 0%, rgba(20,147,160,0.18) 55%, rgba(0,0,0,0.05) 100%)">
          <div aria-hidden="true" style="position:absolute;inset:0;pointer-events:none;opacity:0.08;display:flex;justify-content:space-between;align-items:center;padding:0 12px">
            <span style="font-size:96px;line-height:1;transform:rotate(-16deg)">🕊️</span>
            <span style="font-size:72px;line-height:1;transform:scaleX(-1) rotate(-16deg)">🕊️</span>
          </div>
          <div style="position:relative;display:flex;flex-direction:column;align-items:center;gap:var(--sp-3)">
            <div id="profile-avatar-wrapper" style="position:relative;cursor:pointer;padding:4px;border-radius:50%;background:conic-gradient(from 0deg, var(--roc-gold), #1493a0, var(--roc-gold))" title="Change profile photo">
              <div class="avatar" id="profile-avatar" style="width:104px;height:104px;font-size:40px;line-height:104px;border:3px solid var(--bg-elevated)"></div>
              <div style="position:absolute;bottom:4px;right:4px;width:34px;height:34px;border-radius:50%;background:var(--roc-gold);display:flex;align-items:center;justify-content:center;box-shadow:var(--shadow-md);border:2px solid var(--bg-elevated)">
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="white" stroke-width="2"><path d="M23 19a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4l2-3h6l2 3h4a2 2 0 0 1 2 2z"/><circle cx="12" cy="13" r="4"/></svg>
              </div>
              <input type="file" id="avatar-input" accept="image/jpeg,image/png,image/webp" style="display:none" />
            </div>
            <div style="text-align:center">
              <div style="font-weight:700;font-size:var(--text-xl)" id="setting-display-name">Loading...</div>
              <div style="color:var(--text-tertiary);font-size:var(--text-sm)" id="setting-username">@loading...</div>
              <div style="color:var(--text-secondary);font-size:var(--text-sm);cursor:pointer;margin-top:2px" id="setting-status" title="Click to edit status">Set a status...</div>
            </div>
            <div style="display:inline-flex;align-items:center;gap:6px;padding:5px 12px;border-radius:999px;background:rgba(212,175,55,0.12);border:1px solid rgba(212,175,55,0.4);color:var(--roc-gold);font-size:var(--text-xs);font-weight:600">
              🕊️ Voice of Freedom 🇵🇸
            </div>
            <div style="display:flex;gap:var(--sp-2);margin-top:var(--sp-1)">
              <button class="btn-secondary" style="font-size:var(--text-xs);padding:var(--sp-1) var(--sp-3)" id="edit-name-btn">
                <i data-lucide="pencil" style="width:12px;height:12px"></i> Edit Name
              </button>
              <button class="btn-secondary" style="font-size:var(--text-xs);padding:var(--sp-1) var(--sp-3);color:var(--danger);border-color:var(--danger);display:none" id="remove-avatar-btn">
                <i data-lucide="trash-2" style="width:12px;height:12px"></i> Remove Photo
              </button>
            </div>
          </div>
        </div>

        <div class="settings-section">
          <h3>My QR Code</h3>
          <div style="display:flex;flex-direction:column;align-items:center;gap:var(--sp-3)">
            <div id="my-qr-code" style="background:white;padding:12px;border-radius:16px;display:inline-block"></div>
            <div class="setting-desc" style="text-align:center">Others can scan this to add you on RocChat</div>
            <button class="btn-secondary" id="btn-scan-qr" style="font-size:var(--text-sm);padding:var(--sp-2) var(--sp-4)">
              📷 Scan QR Code
            </button>
          </div>
        </div>

        <div class="settings-section">
          <h3>Privacy</h3>
          <div class="setting-row" style="background:linear-gradient(135deg,rgba(212,175,55,0.08),rgba(64,224,208,0.06));border-radius:var(--radius-lg);padding:var(--sp-3);margin-bottom:var(--sp-2)">
            <div>
              <div class="setting-label" style="font-size:var(--text-base);font-weight:700">👻 Ghost Mode</div>
              <div class="setting-desc">Hide all activity: no read receipts, no typing, no online status, messages auto-expire 24h</div>
            </div>
            <label class="toggle">
              <input type="checkbox" id="toggle-ghost-mode" />
              <span class="toggle-slider"></span>
            </label>
          </div>
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
          <div class="setting-row">
            <div>
              <div class="setting-label">Last seen visible to</div>
              <div class="setting-desc">Who can see when you were last active</div>
            </div>
            <select class="form-input" style="width:auto;padding:var(--sp-2) var(--sp-3)" id="last-seen-visibility">
              <option value="everyone">Everyone</option>
              <option value="contacts">Contacts only</option>
              <option value="nobody">Nobody</option>
            </select>
          </div>
          <div class="setting-row">
            <div>
              <div class="setting-label">Profile photo visible to</div>
              <div class="setting-desc">Who can see your profile picture</div>
            </div>
            <select class="form-input" style="width:auto;padding:var(--sp-2) var(--sp-3)" id="photo-visibility">
              <option value="everyone">Everyone</option>
              <option value="contacts">Contacts only</option>
              <option value="nobody">Nobody</option>
            </select>
          </div>
          <div class="setting-row">
            <div>
              <div class="setting-label">Screenshot detection</div>
              <div class="setting-desc">Notify sender when you screenshot a view-once or disappearing message</div>
            </div>
            <label class="toggle">
              <input type="checkbox" id="toggle-screenshot-detect" checked />
              <span class="toggle-slider"></span>
            </label>
          </div>
          <div class="setting-row" style="cursor:pointer" id="blocked-contacts-row">
            <div>
              <div class="setting-label">Blocked contacts</div>
              <div class="setting-desc">Manage your block list</div>
            </div>
            <span style="color:var(--text-tertiary);font-size:var(--text-sm)">›</span>
          </div>
          <div class="setting-row">
            <div>
              <div class="setting-label">App lock</div>
              <div class="setting-desc">Require PIN to open RocChat</div>
            </div>
            <label class="toggle">
              <input type="checkbox" id="toggle-app-lock" />
              <span class="toggle-slider"></span>
            </label>
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
              <option value="scheduled">Scheduled</option>
            </select>
          </div>
          <div id="scheduled-theme-config" style="display:none;margin-top:var(--sp-3);padding:var(--sp-3);background:var(--bg-primary);border-radius:var(--radius)">
            <div style="font-size:var(--text-sm);color:var(--text-secondary);margin-bottom:var(--sp-2)">Dark mode schedule</div>
            <div style="display:flex;gap:var(--sp-3);align-items:center">
              <label style="font-size:var(--text-sm);color:var(--text-tertiary)">Dark from</label>
              <input type="time" id="theme-dark-start" value="20:00" style="background:var(--bg-primary);border:1px solid var(--border);border-radius:var(--radius);padding:4px 8px;color:var(--text-primary);font-size:var(--text-sm)" />
              <label style="font-size:var(--text-sm);color:var(--text-tertiary)">to</label>
              <input type="time" id="theme-dark-end" value="07:00" style="background:var(--bg-primary);border:1px solid var(--border);border-radius:var(--radius);padding:4px 8px;color:var(--text-primary);font-size:var(--text-sm)" />
              <button class="btn btn-outline" id="save-theme-schedule" style="font-size:var(--text-xs);padding:4px 12px">Save</button>
            </div>
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
          <h3>Push Notifications</h3>
          <div class="setting-row">
            <div>
              <div class="setting-label">Enable Push Notifications</div>
              <div class="setting-desc">Receive message alerts even when RocChat is closed</div>
            </div>
            <button class="btn btn-outline" id="btn-enable-push" style="font-size:var(--text-xs);padding:6px 16px">Enable</button>
          </div>
          <div id="push-status" style="font-size:var(--text-xs);color:var(--text-tertiary);margin-top:var(--sp-1)"></div>
        </div>

        <div class="settings-section">
          <h3>Quiet Hours</h3>
          <div class="setting-row">
            <div>
              <div class="setting-label">Scheduled Quiet Hours</div>
              <div class="setting-desc">Mute all notifications during these hours</div>
            </div>
          </div>
          <div style="display:flex;gap:var(--sp-3);align-items:center;margin-top:var(--sp-2)">
            <label style="font-size:var(--text-sm);color:var(--text-secondary)">From</label>
            <input type="time" id="quiet-start" style="background:var(--bg-primary);border:1px solid var(--border);border-radius:var(--radius);padding:4px 8px;color:var(--text-primary);font-size:var(--text-sm)" />
            <label style="font-size:var(--text-sm);color:var(--text-secondary)">To</label>
            <input type="time" id="quiet-end" style="background:var(--bg-primary);border:1px solid var(--border);border-radius:var(--radius);padding:4px 8px;color:var(--text-primary);font-size:var(--text-sm)" />
            <button class="btn btn-outline" id="save-quiet-hours" style="font-size:var(--text-xs);padding:4px 12px">Save</button>
            <button class="btn-secondary" id="clear-quiet-hours" style="font-size:var(--text-xs);padding:4px 12px">Clear</button>
          </div>
          <div class="setting-row" style="margin-top:var(--sp-3)">
            <div>
              <div class="setting-label">DND Exceptions</div>
              <div class="setting-desc">These contacts will always notify, even during quiet hours</div>
            </div>
          </div>
          <div id="dnd-exceptions-list" style="margin-top:var(--sp-2)">
            <div style="font-size:var(--text-xs);color:var(--text-tertiary)">Loading...</div>
          </div>
          <div style="display:flex;gap:var(--sp-2);margin-top:var(--sp-2)">
            <input type="text" id="dnd-exception-input" placeholder="@username" style="flex:1;background:var(--bg-primary);border:1px solid var(--border);border-radius:var(--radius);padding:6px 10px;color:var(--text-primary);font-size:var(--text-sm)" />
            <button class="btn btn-outline" id="add-dnd-exception" style="font-size:var(--text-xs);padding:4px 12px">Add</button>
          </div>
          <div class="setting-row" style="margin-top:var(--sp-3)">
            <div>
              <div class="setting-label">Keyword Alerts</div>
              <div class="setting-desc">Messages containing these words will break through DND</div>
            </div>
          </div>
          <div id="keyword-alerts-list" style="margin-top:var(--sp-2);display:flex;flex-wrap:wrap;gap:var(--sp-1)">
            <div style="font-size:var(--text-xs);color:var(--text-tertiary)">Loading...</div>
          </div>
          <div style="display:flex;gap:var(--sp-2);margin-top:var(--sp-2)">
            <input type="text" id="keyword-alert-input" placeholder="e.g. emergency, urgent" style="flex:1;background:var(--bg-primary);border:1px solid var(--border);border-radius:var(--radius);padding:6px 10px;color:var(--text-primary);font-size:var(--text-sm)" />
            <button class="btn btn-outline" id="add-keyword-alert" style="font-size:var(--text-xs);padding:4px 12px">Add</button>
          </div>
        </div>

        <div class="settings-section">
          <h3>Devices</h3>
          <div id="devices-list">
            <div class="skeleton-line" style="height:40px;margin-bottom:var(--sp-2)"></div>
            <div class="skeleton-line" style="height:40px;margin-bottom:var(--sp-2)"></div>
          </div>
          <div class="setting-row" style="margin-top:var(--sp-3)">
            <div>
              <div class="setting-label">Device Verification</div>
              <div class="setting-desc">Generate a 6-digit code to verify a new device</div>
            </div>
            <button class="btn btn-outline" id="btn-device-verify">Generate Code</button>
          </div>
          <div id="device-verify-display" style="display:none;margin-top:var(--sp-3);padding:var(--sp-4);background:var(--bg-primary);border-radius:var(--radius);text-align:center">
            <div style="font-size:var(--text-xs);color:var(--text-tertiary);margin-bottom:var(--sp-2)">Enter this code on your new device</div>
            <div id="device-verify-code" style="font-family:var(--font-mono);font-size:32px;letter-spacing:8px;font-weight:700;color:var(--turquoise)"></div>
            <div id="device-verify-timer" style="font-size:var(--text-xs);color:var(--text-tertiary);margin-top:var(--sp-2)"></div>
          </div>
          <div class="setting-row" style="margin-top:var(--sp-2)">
            <div>
              <div class="setting-label">Enter Verification Code</div>
              <div class="setting-desc">Verify this device with a code from another device</div>
            </div>
            <div style="display:flex;gap:var(--sp-2);align-items:center">
              <input type="text" id="device-verify-input" maxlength="6" pattern="[0-9]{6}"
                placeholder="000000" style="width:100px;font-family:var(--font-mono);font-size:var(--text-base);text-align:center;letter-spacing:4px;background:var(--bg-primary);border:1px solid var(--border);border-radius:var(--radius);padding:6px;color:var(--text-primary)" />
              <button class="btn btn-outline" id="btn-device-confirm">Verify</button>
            </div>
          </div>
        </div>

        <div class="settings-section">
          <h3>⭐ Premium Features <span style="font-size:var(--text-xs);color:var(--roc-gold);font-weight:400">FREE for all</span></h3>
          <div class="setting-row">
            <div>
              <div class="setting-label">Chat Themes</div>
              <div class="setting-desc">Pick a color theme for your chat backgrounds</div>
            </div>
            <select class="form-input" style="width:auto;padding:var(--sp-2) var(--sp-3)" id="chat-theme-select">
              <option value="default">Default</option>
              <option value="midnight">Midnight Blue</option>
              <option value="forest">Forest Green</option>
              <option value="sunset">Sunset Amber</option>
              <option value="ocean">Ocean Teal</option>
              <option value="rose">Rose Gold</option>
              <option value="lavender">Lavender</option>
              <option value="charcoal">Charcoal</option>
            </select>
          </div>
          <div class="setting-row">
            <div>
              <div class="setting-label">Scheduled Messages</div>
              <div class="setting-desc">View and manage messages scheduled to send later</div>
            </div>
            <button class="btn-secondary" style="font-size:var(--text-xs);padding:var(--sp-1) var(--sp-3)" id="view-scheduled-btn">
              View
            </button>
          </div>
          <div class="setting-row">
            <div>
              <div class="setting-label">Chat Folders</div>
              <div class="setting-desc">Organize your conversations into custom folders</div>
            </div>
            <button class="btn-secondary" style="font-size:var(--text-xs);padding:var(--sp-1) var(--sp-3)" id="manage-folders-btn">
              Manage
            </button>
          </div>
          <div class="setting-row">
            <div>
              <div class="setting-label">Saved Contacts</div>
              <div class="setting-desc">Manage your saved contacts and nicknames</div>
            </div>
            <button class="btn-secondary" style="font-size:var(--text-xs);padding:var(--sp-1) var(--sp-3)" id="manage-contacts-btn">
              Manage
            </button>
          </div>
          <div class="setting-row">
            <div>
              <div class="setting-label">Invite Link</div>
              <div class="setting-desc">Share a link so others can add you on RocChat</div>
            </div>
            <button class="btn btn-outline" id="btn-invite-link">Generate Link</button>
          </div>
          <div id="invite-link-display" style="display:none;margin-top:var(--sp-2);padding:var(--sp-3);background:var(--bg-primary);border-radius:var(--radius);word-break:break-all">
            <div style="display:flex;align-items:center;gap:var(--sp-2)">
              <code id="invite-link-text" style="flex:1;font-size:var(--text-xs);color:var(--turquoise)"></code>
              <button class="btn-secondary" id="btn-copy-invite" style="font-size:var(--text-xs);padding:var(--sp-1) var(--sp-2);white-space:nowrap">Copy</button>
            </div>
          </div>
        </div>

        <div class="settings-section">
          <h3>🏢 RocChat Business</h3>
          <div id="business-section">
            <div class="setting-row">
              <div>
                <div class="setting-label">Organization Management</div>
                <div class="setting-desc">Admin dashboard, team management, compliance tools, custom branding, SSO, API access and more.</div>
              </div>
            </div>
            <div id="business-content">
              <div class="setting-row" style="flex-direction:column;gap:var(--sp-3)">
                <div style="background:var(--bg-tertiary);border-radius:var(--radius-lg);padding:var(--sp-4);width:100%">
                  <div style="font-weight:600;margin-bottom:var(--sp-2)">Business Plan — $3.99/user/month</div>
                  <ul style="font-size:var(--text-sm);color:var(--text-secondary);list-style:none;padding:0;margin:0;display:grid;gap:var(--sp-1)">
                    <li>🏢 Admin dashboard & user management</li>
                    <li>🏢 Groups up to 5,000 members</li>
                    <li>🏢 Organization directory</li>
                    <li>🏢 Role-based access control</li>
                    <li>🏢 Remote device wipe</li>
                    <li>🏢 Compliance export & audit logs</li>
                    <li>🏢 Message retention policies</li>
                    <li>🏢 Custom branding</li>
                    <li>🏢 SSO (SAML/OIDC)</li>
                    <li>🏢 API & webhook access</li>
                    <li>🏢 Priority support (24h SLA)</li>
                  </ul>
                  <div style="margin-top:var(--sp-3);font-size:var(--text-xs);color:var(--text-tertiary)">
                    Volume: 5-25 users $3.99 · 26-100 $2.99 · 101-500 $1.99 · 500+ custom
                  </div>
                </div>
                <button class="btn-primary" id="upgrade-business-btn" style="width:100%">
                  Upgrade to Business
                </button>
              </div>
            </div>
            <div id="business-dashboard" style="display:none">
              <div id="org-list"></div>
              <button class="btn-secondary" id="create-org-btn" style="margin-top:var(--sp-2);font-size:var(--text-sm)">
                + Create Organization
              </button>
            </div>
          </div>
        </div>

        <div class="settings-section">
          <h3>Import Chat History</h3>
          <div class="setting-row">
            <div>
              <div class="setting-label">📥 One-Click Migration Bridge</div>
              <div class="setting-desc">Drag & drop or select an export file from WhatsApp (.txt), Telegram (.json), or Signal (.json). Format is auto-detected. Messages are re-encrypted with your RocChat keys.</div>
            </div>
          </div>
          <div id="import-dropzone" style="border:2px dashed var(--border-norm);border-radius:var(--radius-lg);padding:var(--sp-6);text-align:center;cursor:pointer;margin-top:var(--sp-2);transition:border-color 0.2s,background 0.2s">
            <div style="font-size:var(--text-xl);margin-bottom:var(--sp-2)">📂</div>
            <div style="font-size:var(--text-sm);color:var(--text-secondary)">Drop your chat export here or click to browse</div>
            <div style="font-size:var(--text-xs);color:var(--text-tertiary);margin-top:var(--sp-1)">Supports .txt, .json, .zip</div>
          </div>
          <div style="display:flex;gap:var(--sp-2);margin-top:var(--sp-3);flex-wrap:wrap">
            <button class="btn-secondary import-btn" data-source="whatsapp" style="font-size:var(--text-sm)">📱 WhatsApp (.txt)</button>
            <button class="btn-secondary import-btn" data-source="telegram" style="font-size:var(--text-sm)">✈️ Telegram (.json)</button>
            <button class="btn-secondary import-btn" data-source="signal" style="font-size:var(--text-sm)">🔒 Signal (.json)</button>
          </div>
          <input type="file" id="import-file-input" accept=".txt,.json,.zip" style="display:none">
          <div id="import-progress-container" style="display:none;margin-top:var(--sp-3)">
            <div style="display:flex;justify-content:space-between;font-size:var(--text-xs);color:var(--text-secondary);margin-bottom:var(--sp-1)">
              <span id="import-progress-label">Importing...</span>
              <span id="import-progress-percent">0%</span>
            </div>
            <div style="height:6px;border-radius:3px;background:var(--bg-input);overflow:hidden">
              <div id="import-progress-bar" style="height:100%;width:0%;background:var(--roc-gold);border-radius:3px;transition:width 0.3s ease"></div>
            </div>
          </div>
          <div id="import-status" style="margin-top:var(--sp-2);font-size:var(--text-xs);color:var(--text-tertiary)"></div>
        </div>

        <div class="settings-section">
          <h3>Support RocChat</h3>
          <div class="setting-row">
            <div>
              <div class="setting-label">💛 All premium features are free forever</div>
              <div class="setting-desc">RocChat is built on the belief that privacy shouldn't cost extra. Business features support team/enterprise needs. If you'd like to support development, donations are welcome.</div>
            </div>
          </div>
          <div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(140px,1fr));gap:var(--sp-2);margin-top:var(--sp-3)" id="donation-tiers">
            <button class="btn-secondary donation-btn" data-amount="3" style="font-size:var(--text-sm);padding:var(--sp-2)">
              ☕ $3<br><span style="font-size:var(--text-xs);color:var(--text-tertiary)">Buy Roc a Coffee</span>
            </button>
            <button class="btn-secondary donation-btn" data-amount="5" style="font-size:var(--text-sm);padding:var(--sp-2)">
              🪶 $5<br><span style="font-size:var(--text-xs);color:var(--text-tertiary)">Feather Supporter</span>
            </button>
            <button class="btn-secondary donation-btn" data-amount="10" style="font-size:var(--text-sm);padding:var(--sp-2)">
              🦅 $10<br><span style="font-size:var(--text-xs);color:var(--text-tertiary)">Wing Supporter</span>
            </button>
            <button class="btn-secondary donation-btn" data-amount="25" style="font-size:var(--text-sm);padding:var(--sp-2)">
              🏔️ $25<br><span style="font-size:var(--text-xs);color:var(--text-tertiary)">Mountain Guardian</span>
            </button>
            <button class="btn-secondary donation-btn" data-amount="50" style="font-size:var(--text-sm);padding:var(--sp-2)">
              👑 $50<br><span style="font-size:var(--text-xs);color:var(--text-tertiary)">Roc Patron</span>
            </button>
            <button class="btn-secondary donation-btn" data-amount="custom" style="font-size:var(--text-sm);padding:var(--sp-2)">
              💎 Custom<br><span style="font-size:var(--text-xs);color:var(--text-tertiary)">Your amount</span>
            </button>
          </div>
          <div style="display:flex;gap:var(--sp-2);flex-wrap:wrap;margin-top:var(--sp-3)">
            <button class="btn-secondary" id="donate-crypto-btn" style="font-size:var(--text-sm)">🪙 Donate With Crypto</button>
          </div>
          <div id="donor-badge-status" style="margin-top:var(--sp-3);padding:var(--sp-3);border-radius:var(--radius-lg);background:var(--bg-tertiary)">
            <div style="font-size:var(--text-sm);font-weight:600;margin-bottom:var(--sp-1)">Your Donor Badge</div>
            <div id="donor-badge-display" style="font-size:var(--text-xs);color:var(--text-tertiary)">Loading...</div>
          </div>
          <div style="margin-top:var(--sp-3);display:flex;gap:var(--sp-3);flex-wrap:wrap">
            <a href="#/canary" style="font-size:var(--text-xs);color:var(--turquoise);text-decoration:none">🐦 View Warrant Canary</a>
            <a href="#/transparency" style="font-size:var(--text-xs);color:var(--turquoise);text-decoration:none">📜 Transparency Report</a>
            <a href="#/supporters" style="font-size:var(--text-xs);color:var(--turquoise);text-decoration:none">🪶 Supporters Wall</a>
          </div>
        </div>

        <div class="settings-section">
          <h3>Power-user features</h3>
          <div class="setting-row">
            <div>
              <div class="setting-label">Scheduled messages</div>
              <div class="setting-desc">View and cancel messages queued for later delivery.</div>
            </div>
            <button class="btn-secondary" id="btn-scheduled-mgr">Open</button>
          </div>
          <div class="setting-row">
            <div>
              <div class="setting-label">Encrypted backup</div>
              <div class="setting-desc">Export or import your keys, messages, and settings, encrypted with a passphrase.</div>
            </div>
            <button class="btn-secondary" id="btn-backup-mgr">Open</button>
          </div>
          <div class="setting-row">
            <div>
              <div class="setting-label">Decoy conversations</div>
              <div class="setting-desc">Local-only fake chats for plausible deniability.</div>
            </div>
            <button class="btn-secondary" id="btn-decoy-mgr">Open</button>
          </div>
          <div class="setting-row">
            <div>
              <div class="setting-label">Custom emoji</div>
              <div class="setting-desc">Upload images and reference them as <code>:shortcode:</code> in messages.</div>
            </div>
            <button class="btn-secondary" id="btn-emoji-mgr">Open</button>
          </div>
        </div>

        <div class="settings-section">
          <h3>About</h3>
          <div class="setting-row">
            <div>
              <div class="setting-label">RocChat v0.1.0</div>
              <div class="setting-desc">Part of the Roc Family (RocMail · RocPass · RocChat) — Free &amp; open for everyone.</div>
            </div>
          </div>
        </div>

        <div class="settings-section" style="border:1px solid var(--roc-gold,#D4AF37);border-radius:var(--radius-lg);padding:var(--sp-4);background:rgba(212,175,55,0.05)">
          <h3 style="color:var(--roc-gold,#D4AF37)">🪶 The Roc Family Manifesto</h3>
          <div style="font-size:var(--text-sm);color:var(--text-secondary);line-height:1.7">
            <p><strong>We are the voice of freedom. We are the voice of the people.</strong></p>
            <p>The Roc Family ecosystem exists for one purpose: to give people secure, private communication without dependence on any corporation, government, or surveillance apparatus.</p>
            <p style="margin-top:var(--sp-2)"><strong>Our principles:</strong></p>
            <ul style="margin:var(--sp-2) 0;padding-left:var(--sp-4)">
              <li>🔒 <strong>Zero third-party dependencies</strong> — No Google, no Apple services, no Stripe, no Cloudflare CAPTCHA, no corporate APIs. Every component is self-hosted or open-source.</li>
              <li>🕊️ <strong>No complicity in oppression</strong> — We do not support, partner with, or depend on entities that participate in the oppression of people anywhere in the world.</li>
              <li>✊ <strong>Privacy is a human right</strong> — End-to-end encryption by default. We cannot read your messages. We will never sell your data. There is no data to sell.</li>
              <li>🌍 <strong>Free for everyone, forever</strong> — No paywalls, no premium tiers that gate security features. All features are free. Donations via cryptocurrency only — no corporate payment processors.</li>
              <li>🛡️ <strong>Proof-of-work, not surveillance</strong> — We use mathematical proof-of-work instead of corporate CAPTCHAs that track you.</li>
              <li>📡 <strong>Self-sovereign infrastructure</strong> — Self-hosted STUN/TURN servers, self-hosted push notifications, self-hosted fonts and icons. No phone call touches Google's servers.</li>
              <li>🏴 <strong>Transparency</strong> — Open-source code, public warrant canary, regular transparency reports. If we are ever compromised, you will know.</li>
            </ul>
            <p style="margin-top:var(--sp-2);font-style:italic;color:var(--roc-gold,#D4AF37)">Built with love, for the people. 🇵🇸</p>
          </div>
        </div>

        <div style="padding:var(--sp-4) 0;display:flex;gap:var(--sp-3);flex-wrap:wrap">
          <button class="btn-secondary" id="export-data-btn" style="color:var(--text-secondary);border-color:var(--border-norm)">
            Export My Data
          </button>
          <button class="btn-secondary" id="logout-btn" style="color:var(--danger);border-color:var(--danger)">
            Sign Out
          </button>
          <button class="btn-secondary" id="delete-account-btn" style="color:#fff;background:var(--danger);border-color:var(--danger)">
            Delete Account
          </button>
        </div>
      </div>
    </div>
  `;

  // Load profile
  loadProfile();
  loadDevices();

  // Device verification — generate code (SOURCE device)
  document.getElementById('btn-device-verify')?.addEventListener('click', async () => {
    const btn = document.getElementById('btn-device-verify') as HTMLButtonElement;
    btn.disabled = true;
    btn.textContent = 'Generating...';
    try {
      const res = await api.initiateDeviceVerification();
      if (res.ok) {
        const display = document.getElementById('device-verify-display')!;
        const codeEl = document.getElementById('device-verify-code')!;
        const timerEl = document.getElementById('device-verify-timer')!;
        display.style.display = 'block';
        codeEl.textContent = res.data.code.replace(/(\d{3})(\d{3})/, '$1 $2');
        let remaining = res.data.expires_in;
        const updateTimer = () => {
          const m = Math.floor(remaining / 60);
          const s = remaining % 60;
          timerEl.textContent = `Expires in ${m}:${s.toString().padStart(2, '0')}`;
          if (remaining <= 0) {
            display.style.display = 'none';
            btn.disabled = false;
            btn.textContent = 'Generate Code';
          }
          remaining--;
        };
        updateTimer();
        const interval = setInterval(() => {
          updateTimer();
          if (remaining < 0) clearInterval(interval);
        }, 1000);

        // Poll for pending key transfer requests from new devices
        const pollInterval = setInterval(async () => {
          if (remaining <= 0) { clearInterval(pollInterval); return; }
          try {
            const pending = await api.getPendingKeyTransfers();
            if (pending.ok && pending.data.requests.length > 0) {
              clearInterval(pollInterval);
              for (const req of pending.data.requests) {
                await handleKeyTransferAsSource(req.requestId, req.ephemeralPub);
              }
              showToast('Keys transferred to new device!');
            }
          } catch { /* retry */ }
        }, 2000);
      }
    } catch { /* */ }
    btn.disabled = false;
    btn.textContent = 'Generate Code';
  });

  // Device verification — confirm code (NEW device)
  document.getElementById('btn-device-confirm')?.addEventListener('click', async () => {
    const input = document.getElementById('device-verify-input') as HTMLInputElement;
    const code = input.value.replace(/\s/g, '');
    if (code.length !== 6) { showToast('Enter a 6-digit code', 'error'); return; }
    try {
      const res = await api.confirmDeviceVerification(code);
      if (res.ok && res.data.verified) {
        showToast('Device verified! Requesting key transfer...');
        input.value = '';
        // Start key transfer as new device
        await requestKeyTransferAsNewDevice();
      } else {
        showToast('Invalid or expired code', 'error');
      }
    } catch {
      showToast('Verification failed', 'error');
    }
  });

  // Theme selector
  const themeSelect = document.getElementById('theme-select') as HTMLSelectElement;
  const savedTheme = localStorage.getItem('rocchat_theme') || 'auto';
  themeSelect.value = savedTheme;
  const schedConfig = document.getElementById('scheduled-theme-config');
  if (savedTheme === 'scheduled' && schedConfig) schedConfig.style.display = 'block';
  // Load saved schedule times
  const savedDarkStart = localStorage.getItem('rocchat_theme_dark_start') || '20:00';
  const savedDarkEnd = localStorage.getItem('rocchat_theme_dark_end') || '07:00';
  const darkStartInput = document.getElementById('theme-dark-start') as HTMLInputElement;
  const darkEndInput = document.getElementById('theme-dark-end') as HTMLInputElement;
  if (darkStartInput) darkStartInput.value = savedDarkStart;
  if (darkEndInput) darkEndInput.value = savedDarkEnd;

  themeSelect.addEventListener('change', () => {
    const theme = themeSelect.value;
    localStorage.setItem('rocchat_theme', theme);
    if (schedConfig) schedConfig.style.display = theme === 'scheduled' ? 'block' : 'none';
    applyTheme(theme);
  });

  document.getElementById('save-theme-schedule')?.addEventListener('click', () => {
    const start = (document.getElementById('theme-dark-start') as HTMLInputElement)?.value || '20:00';
    const end = (document.getElementById('theme-dark-end') as HTMLInputElement)?.value || '07:00';
    localStorage.setItem('rocchat_theme_dark_start', start);
    localStorage.setItem('rocchat_theme_dark_end', end);
    applyTheme('scheduled');
    showToast('Theme schedule saved');
  });

  // QR Code generation
  const username = localStorage.getItem('rocchat_username') || '';
  const identityKey = localStorage.getItem('rocchat_identity_public') || '';
  if (username && identityKey) {
    const qrData = JSON.stringify({ u: username, k: identityKey, v: 1 });
    const qrEl = document.getElementById('my-qr-code');
    if (qrEl) qrEl.innerHTML = generateQRCodeSVG(qrData, 200);
  }

  // QR Scanner
  document.getElementById('btn-scan-qr')?.addEventListener('click', async () => {
    const overlay = document.createElement('div');
    overlay.className = 'view-once-modal';
    overlay.innerHTML = `
      <div class="view-once-dialog" style="max-width:400px;text-align:center">
        <h3 style="margin:0 0 12px">Scan QR Code</h3>
        <video id="qr-video" style="width:100%;max-height:300px;border-radius:12px;background:#000" autoplay playsinline></video>
        <p id="qr-status" style="margin:12px 0 0;font-size:var(--text-sm);color:var(--text-tertiary)">Point camera at a RocChat QR code</p>
        <button class="btn-secondary" id="qr-close" style="margin-top:12px">Close</button>
      </div>
    `;
    document.body.appendChild(overlay);

    const video = overlay.querySelector('#qr-video') as HTMLVideoElement;
    const status = overlay.querySelector('#qr-status') as HTMLElement;
    let stream: MediaStream | null = null;
    let scanning = true;

    const cleanup = () => {
      scanning = false;
      stream?.getTracks().forEach(t => t.stop());
      overlay.remove();
    };

    overlay.querySelector('#qr-close')?.addEventListener('click', cleanup);
    overlay.addEventListener('click', (e) => { if (e.target === overlay) cleanup(); });

    try {
      stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' } });
      video.srcObject = stream;

      // Use BarcodeDetector if available, otherwise canvas-based scanning
      const hasBarcodeDetector = 'BarcodeDetector' in window;
      if (hasBarcodeDetector) {
        const detector = new (window as any).BarcodeDetector({ formats: ['qr_code'] });
        const scan = async () => {
          if (!scanning) return;
          try {
            const barcodes = await detector.detect(video);
            if (barcodes.length > 0) {
              await handleQrResult(barcodes[0].rawValue, status, cleanup);
              return;
            }
          } catch {}
          requestAnimationFrame(scan);
        };
        video.onloadeddata = () => scan();
      } else {
        // Fallback: manual canvas scanning loop
        const canvas = document.createElement('canvas');
        const ctx = canvas.getContext('2d')!;
        const scanLoop = () => {
          if (!scanning || video.videoWidth === 0) { requestAnimationFrame(scanLoop); return; }
          canvas.width = video.videoWidth;
          canvas.height = video.videoHeight;
          ctx.drawImage(video, 0, 0);
          // No jsQR library — prompt user to paste the QR data
          status.innerHTML = 'Camera scanning not supported in this browser.<br>Paste QR text: <input id="qr-paste" style="margin-top:8px;padding:4px 8px;border:1px solid var(--border-norm);border-radius:6px" placeholder="Paste QR data..." />';
          const pasteInput = status.querySelector('#qr-paste');
          pasteInput?.addEventListener('change', async (e) => {
            await handleQrResult((e.target as HTMLInputElement).value, status, cleanup);
          });
        };
        video.onloadeddata = () => scanLoop();
      }
    } catch {
      status.textContent = 'Camera access denied. Check permissions.';
    }
  });

  async function handleQrResult(raw: string, statusEl: HTMLElement, cleanup: () => void) {
    try {
      const data = JSON.parse(raw);
      if (data.u && data.k) {
        statusEl.textContent = `Found @${data.u}! Adding contact...`;
        const res = await api.searchUsers(data.u);
        if (res.ok && res.data.results?.length > 0) {
          const user = res.data.results[0];
          const convRes = await api.createConversation({ type: 'direct', member_ids: [user.userId] });
          if (convRes.ok) {
            cleanup();
            showToast(`Added @${data.u}!`, 'success');
            return;
          }
        }
        statusEl.textContent = `User @${data.u} not found`;
      } else {
        statusEl.textContent = 'Not a valid RocChat QR code';
      }
    } catch {
      statusEl.textContent = 'Invalid QR code data';
    }
  }

  // Ghost Mode toggle
  document.getElementById('toggle-ghost-mode')?.addEventListener('change', async (e) => {
    const checked = (e.target as HTMLInputElement).checked;
    if (checked) {
      // Enable ghost mode: disable receipts, typing, hide online, set 24h disappear
      await saveSetting(() => api.updateSettings({
        show_read_receipts: 0,
        show_typing_indicator: 0,
        show_online_to: 'nobody',
        default_disappear_timer: 86400,
      }));
      (document.getElementById('toggle-receipts') as HTMLInputElement).checked = false;
      (document.getElementById('toggle-typing') as HTMLInputElement).checked = false;
      (document.getElementById('online-visibility') as HTMLSelectElement).value = 'nobody';
      (document.getElementById('default-disappear') as HTMLSelectElement).value = '86400';
      localStorage.setItem('rocchat_ghost_mode', '1');
      showToast('Ghost Mode enabled', 'success');
    } else {
      // Restore defaults
      await saveSetting(() => api.updateSettings({
        show_read_receipts: 1,
        show_typing_indicator: 1,
        show_online_to: 'everyone',
        default_disappear_timer: 0,
      }));
      (document.getElementById('toggle-receipts') as HTMLInputElement).checked = true;
      (document.getElementById('toggle-typing') as HTMLInputElement).checked = true;
      (document.getElementById('online-visibility') as HTMLSelectElement).value = 'everyone';
      (document.getElementById('default-disappear') as HTMLSelectElement).value = '0';
      localStorage.removeItem('rocchat_ghost_mode');
      showToast('Ghost Mode disabled', 'success');
    }
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

  // Last seen visibility
  document.getElementById('last-seen-visibility')?.addEventListener('change', async (e) => {
    const value = (e.target as HTMLSelectElement).value;
    await saveSetting(() => api.updateSettings({ show_last_seen_to: value }));
  });

  // Profile photo visibility
  document.getElementById('photo-visibility')?.addEventListener('change', async (e) => {
    const value = (e.target as HTMLSelectElement).value;
    await saveSetting(() => api.updateSettings({ show_photo_to: value }));
  });

  // Screenshot detection toggle
  document.getElementById('toggle-screenshot-detect')?.addEventListener('change', async (e) => {
    const checked = (e.target as HTMLInputElement).checked;
    await saveSetting(() => api.updateSettings({ screenshot_detection: checked ? 1 : 0 }));
  });

  // Blocked contacts management
  document.getElementById('blocked-contacts-row')?.addEventListener('click', () => {
    showBlockedContactsDialog();
  });

  // App lock toggle
  document.getElementById('toggle-app-lock')?.addEventListener('change', (e) => {
    const checked = (e.target as HTMLInputElement).checked;
    if (checked) {
      showAppLockSetup();
    } else {
      localStorage.removeItem('rocchat_app_lock_pin');
      showToast('App lock disabled', 'success');
    }
  });

  // Default disappearing timer
  document.getElementById('default-disappear')?.addEventListener('change', async (e) => {
    const value = parseInt((e.target as HTMLSelectElement).value, 10);
    await saveSetting(() => api.updateSettings({ default_disappear_timer: value || null }));
  });

  // Export data
  document.getElementById('export-data-btn')?.addEventListener('click', async () => {
    const btn = document.getElementById('export-data-btn') as HTMLButtonElement;
    btn.disabled = true;
    btn.textContent = 'Exporting...';
    try {
      const res = await api.exportData();
      if (res.ok) {
        const blob = new Blob([JSON.stringify(res.data.export, null, 2)], { type: 'application/json' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `rocchat-export-${Date.now()}.json`;
        a.click();
        URL.revokeObjectURL(url);
      } else {
        alert('Export failed');
      }
    } catch { alert('Export failed'); }
    btn.disabled = false;
    btn.textContent = 'Export My Data';
  });

  // Delete account
  document.getElementById('delete-account-btn')?.addEventListener('click', async () => {
    const confirm1 = confirm('Are you sure you want to permanently delete your account? This cannot be undone.');
    if (!confirm1) return;
    const confirm2 = prompt('Type DELETE to confirm account deletion:');
    if (confirm2 !== 'DELETE') return;
    try {
      await api.deleteAccount();
      api.setToken(null);
      api.setRefreshToken(null);
      localStorage.clear();
      sessionStorage.clear();
      await clearAllSecrets();
      location.reload();
    } catch { alert('Account deletion failed. Please try again.'); }
  });

  // Logout
  document.getElementById('logout-btn')?.addEventListener('click', async () => {
    try { await api.logout(); } catch { /* continue with local cleanup */ }
    api.setToken(null);
    api.setRefreshToken(null);
    localStorage.removeItem('rocchat_user_id');
    localStorage.removeItem('rocchat_keys');
    localStorage.removeItem('rocchat_identity_pub');
    localStorage.removeItem('rocchat_identity_priv');
    localStorage.removeItem('rocchat_identity_dh');
    localStorage.removeItem('rocchat_spk_pub');
    await clearAllSecrets();
    sessionStorage.clear();
    location.reload();
  });

  if (typeof (window as any).lucide !== 'undefined') {
    (window as any).lucide.createIcons();
  }

  // Edit display name
  document.getElementById('edit-name-btn')?.addEventListener('click', () => {
    const nameEl = document.getElementById('setting-display-name');
    const current = nameEl?.textContent || '';
    const newName = prompt('Enter new display name:', current);
    if (newName && newName.trim() && newName.trim() !== current) {
      saveSetting(async () => {
        await api.updateSettings({ display_name: newName.trim() });
        if (nameEl) nameEl.textContent = newName.trim();
      });
    }
  });

  // Edit status text
  document.getElementById('setting-status')?.addEventListener('click', () => {
    const statusEl = document.getElementById('setting-status');
    const current = statusEl?.dataset.status || '';
    const newStatus = prompt('Set your status (140 chars max):', current);
    if (newStatus !== null) {
      const text = newStatus.trim().slice(0, 140);
      saveSetting(async () => {
        await api.updateSettings({ status_text: text });
        if (statusEl) {
          statusEl.textContent = text || 'Set a status...';
          statusEl.dataset.status = text;
        }
      });
    }
  });

  // Avatar upload
  document.getElementById('profile-avatar-wrapper')?.addEventListener('click', () => {
    document.getElementById('avatar-input')?.click();
  });

  document.getElementById('avatar-input')?.addEventListener('change', async (e) => {
    const file = (e.target as HTMLInputElement).files?.[0];
    if (!file) return;
    if (file.size > 5 * 1024 * 1024) { showToast('Image too large (max 5MB)', 'error'); return; }
    try {
      const res = await api.uploadAvatar(file);
      if (res.ok) {
        showToast('Profile photo updated');
        loadProfile();
      } else {
        showToast('Failed to upload photo', 'error');
      }
    } catch { showToast('Upload failed', 'error'); }
  });

  // Remove avatar
  document.getElementById('remove-avatar-btn')?.addEventListener('click', async () => {
    if (!confirm('Remove your profile photo?')) return;
    try {
      const res = await api.deleteAvatar();
      if (res.ok) {
        showToast('Photo removed');
        loadProfile();
      }
    } catch { showToast('Failed to remove photo', 'error'); }
  });

  // ── Chat Theme ──
  const chatThemeSelect = document.getElementById('chat-theme-select') as HTMLSelectElement;
  const savedChatTheme = localStorage.getItem('rocchat_chat_theme') || 'default';
  chatThemeSelect.value = savedChatTheme;
  chatThemeSelect.addEventListener('change', () => {
    localStorage.setItem('rocchat_chat_theme', chatThemeSelect.value);
    applyChatTheme(chatThemeSelect.value);
    showToast('Chat theme updated');
  });

  // ── Scheduled Messages ──
  document.getElementById('view-scheduled-btn')?.addEventListener('click', () => showScheduledMessages());

  // ── Power-user features ──
  import('../features.js').then((features) => {
    document.getElementById('btn-scheduled-mgr')?.addEventListener('click', () => features.openScheduledMessagesDialog());
    document.getElementById('btn-backup-mgr')?.addEventListener('click', () => features.openBackupDialog());
    document.getElementById('btn-decoy-mgr')?.addEventListener('click', () => features.openDecoyManager());
    document.getElementById('btn-emoji-mgr')?.addEventListener('click', () => features.openCustomEmojiManager());
  });

  // ── Chat Folders ──
  document.getElementById('manage-folders-btn')?.addEventListener('click', () => showFoldersManager());

  // ── Saved Contacts ──
  document.getElementById('manage-contacts-btn')?.addEventListener('click', () => showContactsManager());

  // ── Invite Link ──
  document.getElementById('btn-invite-link')?.addEventListener('click', async () => {
    const btn = document.getElementById('btn-invite-link') as HTMLButtonElement;
    btn.disabled = true;
    btn.textContent = 'Generating…';
    try {
      const res = await api.getInviteLink();
      const link = res.data.link;
      const display = document.getElementById('invite-link-display')!;
      const text = document.getElementById('invite-link-text')!;
      text.textContent = link;
      display.style.display = 'block';
      btn.textContent = 'Regenerate';
    } catch {
      showToast('Failed to generate invite link', 'error');
      btn.textContent = 'Generate Link';
    }
    btn.disabled = false;
  });

  document.getElementById('btn-copy-invite')?.addEventListener('click', async () => {
    const link = document.getElementById('invite-link-text')?.textContent;
    if (!link) return;
    try {
      if (navigator.share) {
        await navigator.share({ title: 'Add me on RocChat', url: link });
      } else {
        await navigator.clipboard.writeText(link);
        showToast('Invite link copied!', 'success');
      }
    } catch {
      await navigator.clipboard.writeText(link);
      showToast('Invite link copied!', 'success');
    }
  });

  // ── Business ──
  document.getElementById('upgrade-business-btn')?.addEventListener('click', async () => {
    try {
      const res = await api.createCryptoCheckout('business');
      if (res.data.wallet_address) {
        showToast(`Send ${res.data.amount_crypto} ${res.data.crypto_symbol} to ${res.data.wallet_address} (memo: ${res.data.memo})`, 'success');
      } else {
        showToast('Business tier not configured yet. Contact sales@mocipher.com for early access.', 'error');
      }
    } catch {
      showToast('Business tier not available yet. Contact sales@mocipher.com for early access.', 'error');
    }
  });
  document.getElementById('create-org-btn')?.addEventListener('click', () => {
    const name = prompt('Organization name:');
    if (name && name.trim()) {
      api.createOrganization(name.trim()).then(res => {
        if (res.ok) {
          showToast('Organization created');
          loadBusinessDashboard();
        } else {
          showToast('Failed to create organization', 'error');
        }
      });
    }
  });

  // Chat import — one-click migration bridge with auto-detect & progress bar
  let importSource = '';
  const importFileInput = document.getElementById('import-file-input') as HTMLInputElement;
  const importStatus = document.getElementById('import-status')!;
  const importDropzone = document.getElementById('import-dropzone')!;
  const progressContainer = document.getElementById('import-progress-container')!;
  const progressBar = document.getElementById('import-progress-bar')!;
  const progressLabel = document.getElementById('import-progress-label')!;
  const progressPercent = document.getElementById('import-progress-percent')!;

  function setProgress(pct: number, label: string) {
    progressContainer.style.display = 'block';
    progressBar.style.width = `${pct}%`;
    progressPercent.textContent = `${Math.round(pct)}%`;
    progressLabel.textContent = label;
  }

  function hideProgress() { progressContainer.style.display = 'none'; }

  function autoDetectSource(text: string, filename: string): string {
    // Check filename hints first
    if (filename.match(/whatsapp/i) || filename.endsWith('.txt')) {
      // Verify it looks like WhatsApp format
      if (text.match(/^\d{1,2}\/\d{1,2}\/\d{2,4},?\s+\d{1,2}:\d{2}/m)) return 'whatsapp';
    }
    // Try JSON parse
    try {
      const data = JSON.parse(text);
      // Telegram has type: "personal_chat" or messages with from field
      if (data.type || (data.messages && data.messages[0]?.from)) return 'telegram';
      // Signal has messages with body+source or conversationId
      if (data.messages && data.messages[0]?.body) return 'signal';
      if (Array.isArray(data) && data[0]?.body) return 'signal';
    } catch { /* not json */ }
    // Default: check WhatsApp txt pattern
    if (text.match(/^\d{1,2}\/\d{1,2}\/\d{2,4},?\s+\d{1,2}:\d{2}/m)) return 'whatsapp';
    return '';
  }

  async function handleImportFile(file: File, sourceOverride?: string) {
    importStatus.textContent = '';
    setProgress(5, 'Reading file...');

    try {
      const text = await file.text();
      const source = sourceOverride || autoDetectSource(text, file.name);
      if (!source) {
        hideProgress();
        importStatus.textContent = '⚠️ Could not detect format. Please use a specific import button.';
        return;
      }

      setProgress(15, `Detected ${source} format. Parsing...`);
      let parsed: Array<{ sender_name: string; body: string; timestamp: string }> = [];

      if (source === 'whatsapp') {
        const lines = text.split('\n');
        for (const line of lines) {
          const match = line.match(/^(\d{1,2}\/\d{1,2}\/\d{2,4},?\s+\d{1,2}:\d{2}(?:\s*[AP]M)?)\s*-\s*([^:]+):\s*(.+)$/);
          if (match) {
            parsed.push({ timestamp: match[1], sender_name: match[2].trim(), body: match[3] });
          }
        }
      } else if (source === 'telegram') {
        const data = JSON.parse(text);
        const msgs = data.messages || data;
        for (const m of (Array.isArray(msgs) ? msgs : [])) {
          if (typeof m.text === 'string' && m.text) {
            parsed.push({ sender_name: m.from || m.from_id || 'Unknown', body: m.text, timestamp: m.date || '' });
          }
        }
      } else if (source === 'signal') {
        const data = JSON.parse(text);
        const msgs = data.messages || data;
        for (const m of (Array.isArray(msgs) ? msgs : [])) {
          if (m.body) {
            parsed.push({ sender_name: m.source || m.conversationId || 'Unknown', body: m.body, timestamp: m.sent_at || m.timestamp || '' });
          }
        }
      }

      if (parsed.length === 0) {
        hideProgress();
        importStatus.textContent = 'No messages found in file. Check the file format.';
        return;
      }

      setProgress(30, `Found ${parsed.length} messages from ${source}`);

      const convName = prompt(`Found ${parsed.length} messages (${source}). Enter conversation name to import into:`);
      if (!convName) { hideProgress(); importStatus.textContent = ''; return; }

      setProgress(35, 'Creating conversation...');
      const convRes = await api.createConversation({ type: 'direct', member_ids: [], name: convName });
      const convId = convRes.data?.conversation_id;
      if (!convId) { hideProgress(); importStatus.textContent = 'Failed to create conversation'; return; }

      // Batch upload with progress
      let total = 0;
      const chunkSize = 500;
      const totalChunks = Math.ceil(parsed.length / chunkSize);
      for (let i = 0; i < parsed.length; i += chunkSize) {
        const batch = parsed.slice(i, i + chunkSize);
        const res = await api.importMessages(source, convId, batch);
        total += res.data?.imported || 0;
        const chunksDone = Math.floor(i / chunkSize) + 1;
        const pct = 35 + (chunksDone / totalChunks) * 65;
        setProgress(pct, `Importing: ${total} of ${parsed.length} messages...`);
      }

      setProgress(100, 'Complete!');
      importStatus.textContent = `✅ Imported ${total} messages from ${source}`;
      showToast(`Imported ${total} messages from ${source}`, 'success');
      setTimeout(hideProgress, 3000);

      // Offer to invite contacts not yet on RocChat
      const uniqueSenders = [...new Set(parsed.map(m => m.sender_name))];
      if (uniqueSenders.length > 0) {
        const doInvite = confirm(
          `Found ${uniqueSenders.length} contact(s) in this chat. Generate invite links for contacts not yet on RocChat?`
        );
        if (doInvite) {
          try {
            const inviteRes = await api.get('/contacts/invite-link');
            const link = (inviteRes.data as { invite_link?: string })?.invite_link;
            if (link) {
              try { await navigator.clipboard.writeText(link); } catch { /* ignore */ }
              showToast('Invite link copied to clipboard!', 'success');
              importStatus.textContent += ` | 📎 Invite link: ${link}`;
            }
          } catch { showToast('Could not generate invite link', 'error'); }
        }
      }
    } catch (err) {
      hideProgress();
      importStatus.textContent = 'Import failed — check file format';
      showToast('Import failed', 'error');
    }
  }

  // Drag & drop
  importDropzone?.addEventListener('dragover', (e) => {
    e.preventDefault();
    importDropzone.style.borderColor = 'var(--roc-gold)';
    importDropzone.style.background = 'var(--roc-gold-bg, rgba(212,175,55,0.05))';
  });
  importDropzone?.addEventListener('dragleave', () => {
    importDropzone.style.borderColor = 'var(--border-norm)';
    importDropzone.style.background = '';
  });
  importDropzone?.addEventListener('drop', (e) => {
    e.preventDefault();
    importDropzone.style.borderColor = 'var(--border-norm)';
    importDropzone.style.background = '';
    const file = (e as DragEvent).dataTransfer?.files[0];
    if (file) handleImportFile(file);
  });
  importDropzone?.addEventListener('click', () => {
    importSource = '';
    importFileInput.click();
  });

  // Manual source buttons
  document.querySelectorAll('.import-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      importSource = (btn as HTMLElement).dataset.source || '';
      importFileInput.click();
    });
  });

  importFileInput?.addEventListener('change', async () => {
    const file = importFileInput.files?.[0];
    if (!file) return;
    await handleImportFile(file, importSource || undefined);
    importFileInput.value = '';
  });

  // Donation buttons — crypto checkout only
  document.querySelectorAll('.donation-btn').forEach(btn => {
    btn.addEventListener('click', async () => {
      const amount = (btn as HTMLElement).dataset.amount;
      let donationAmount = 5;
      if (amount === 'custom') {
        const custom = prompt('Enter donation amount ($):');
        if (!custom || parseFloat(custom) <= 0) return;
        donationAmount = parseFloat(custom);
      } else {
        donationAmount = parseFloat(amount || '5');
      }
      try {
        const res = await api.createCryptoCheckout('donation', donationAmount);
        if (res.data.wallet_address) {
          showToast(`Send ${res.data.amount_crypto} ${res.data.crypto_symbol} to ${res.data.wallet_address} (memo: ${res.data.memo})`, 'success');
        } else {
          showToast('Crypto donations not configured yet', 'error');
        }
      } catch {
        showToast('Payment not available yet', 'error');
      }
    });
  });

  document.getElementById('donate-crypto-btn')?.addEventListener('click', async () => {
    const amountRaw = prompt('Donation amount in USD (example: 5):', '5');
    if (!amountRaw) return;
    const amount = parseFloat(amountRaw);
    if (!Number.isFinite(amount) || amount <= 0) {
      showToast('Invalid amount', 'error');
      return;
    }
    const recurring = confirm('Make this a recurring supporter donation?');
    try {
      const res = await api.createCryptoCheckout('donation', amount, recurring);
      if (!res.ok) {
        showToast('Crypto checkout unavailable', 'error');
        return;
      }
      const txHash = prompt(
        `Send ${res.data.amount_crypto} ${res.data.crypto_symbol} to:\n${res.data.wallet_address}\nMemo: ${res.data.memo}\n\nAfter sending, paste transaction hash:`
      );
      if (!txHash) return;
      const confirmRes = await api.confirmCryptoCheckout(res.data.id, txHash.trim());
      if (confirmRes.ok) {
        showToast('Crypto donation confirmed. Thank you!');
        loadDonorBadge();
      } else {
        showToast('Could not confirm payment', 'error');
      }
    } catch {
      showToast('Crypto checkout failed', 'error');
    }
  });

  // No Apple IAP or Google Play verification — crypto donations only.

  // Check if user has business tier and show dashboard
  loadBusinessState();
  loadDonorBadge();
  loadQuietHours();

  // Push notification toggle
  const pushBtn = document.getElementById('btn-enable-push');
  const pushStatus = document.getElementById('push-status');
  if (pushBtn && pushStatus) {
    // Check current state
    if ('serviceWorker' in navigator && 'PushManager' in window) {
      navigator.serviceWorker.getRegistration().then(reg => {
        if (!reg) { pushStatus.textContent = 'Service worker not available'; return; }
        reg.pushManager.getSubscription().then(sub => {
          if (sub) {
            pushBtn.textContent = 'Disable';
            pushStatus.textContent = '✅ Push notifications are enabled';
          } else {
            pushBtn.textContent = 'Enable';
            pushStatus.textContent = 'Push notifications are disabled';
          }
        });
      });
    } else {
      pushBtn.style.display = 'none';
      pushStatus.textContent = 'Push notifications not supported in this browser';
    }
    pushBtn.addEventListener('click', async () => {
      const reg = await navigator.serviceWorker.getRegistration();
      if (!reg) return;
      const sub = await reg.pushManager.getSubscription();
      if (sub) {
        // Unsubscribe
        await sub.unsubscribe();
        pushBtn.textContent = 'Enable';
        pushStatus.textContent = 'Push notifications are disabled';
        showToast('Push notifications disabled', 'success');
      } else {
        // Subscribe
        if ((window as any).__rocchatEnablePush) {
          await (window as any).__rocchatEnablePush();
          const newSub = await reg.pushManager.getSubscription();
          if (newSub) {
            pushBtn.textContent = 'Disable';
            pushStatus.textContent = '✅ Push notifications are enabled';
            showToast('Push notifications enabled', 'success');
          }
        }
      }
    });
  }

  // Quiet hours event handlers
  document.getElementById('save-quiet-hours')?.addEventListener('click', async () => {
    const start = (document.getElementById('quiet-start') as HTMLInputElement)?.value;
    const end = (document.getElementById('quiet-end') as HTMLInputElement)?.value;
    if (!start || !end) { showToast('Set both start and end times', 'error'); return; }
    try {
      await api.put('/features/quiet-hours', { quiet_start: start, quiet_end: end });
      showToast('Quiet hours saved');
    } catch { showToast('Failed to save', 'error'); }
  });

  document.getElementById('clear-quiet-hours')?.addEventListener('click', async () => {
    try {
      await api.del('/features/quiet-hours');
      (document.getElementById('quiet-start') as HTMLInputElement).value = '';
      (document.getElementById('quiet-end') as HTMLInputElement).value = '';
      showToast('Quiet hours cleared');
    } catch { showToast('Failed to clear', 'error'); }
  });

  document.getElementById('add-dnd-exception')?.addEventListener('click', async () => {
    const input = document.getElementById('dnd-exception-input') as HTMLInputElement;
    const username = input.value.trim().replace('@', '');
    if (!username) return;
    try {
      const searchRes = await api.searchUsers(username);
      if (!searchRes.ok || !(searchRes.data as { results: Array<{ userId: string }> }).results?.length) {
        showToast('User not found', 'error'); return;
      }
      const userId = (searchRes.data as { results: Array<{ userId: string }> }).results[0].userId;
      const current = await api.get('/features/quiet-hours');
      const exceptions: string[] = (current.data as { dnd_exceptions: string[] }).dnd_exceptions || [];
      if (!exceptions.includes(userId)) {
        exceptions.push(userId);
        await api.put('/features/quiet-hours', { dnd_exceptions: exceptions });
      }
      input.value = '';
      loadQuietHours();
      showToast('Exception added');
    } catch { showToast('Failed to add exception', 'error'); }
  });

  // Keyword alerts handlers
  document.getElementById('add-keyword-alert')?.addEventListener('click', async () => {
    const input = document.getElementById('keyword-alert-input') as HTMLInputElement;
    const keyword = input.value.trim().toLowerCase();
    if (!keyword) return;
    try {
      const current = await api.get('/features/quiet-hours');
      const keywords: string[] = (current.data as { alert_keywords: string[] }).alert_keywords || [];
      if (keywords.length >= 20) { showToast('Max 20 keywords', 'error'); return; }
      if (!keywords.includes(keyword)) {
        keywords.push(keyword);
        await api.put('/features/quiet-hours', { alert_keywords: keywords });
      }
      input.value = '';
      loadQuietHours();
      showToast('Keyword added');
    } catch { showToast('Failed to add keyword', 'error'); }
  });

  document.getElementById('keyword-alert-input')?.addEventListener('keydown', (e) => {
    if ((e as KeyboardEvent).key === 'Enter') document.getElementById('add-keyword-alert')?.click();
  });
}

async function loadDonorBadge() {
  const display = document.getElementById('donor-badge-display');
  if (!display) return;
  try {
    const res = await api.get('/features/donor');
    const donor = (res.data as { tier?: string; recurring?: boolean; donor_since?: number | null });
    const tier = donor?.tier;
    const tierNames: Record<string, string> = {
      coffee: '☕ Coffee — Bronze Feather',
      feather: '🪶 Feather — Amber Feather',
      wing: '🦅 Wing — Golden Feather',
      mountain: '🏔️ Mountain — Radiant Feather',
      patron: '👑 Patron — Turquoise-tipped Feather',
    };
    if (tier && tierNames[tier]) {
      const userId = localStorage.getItem('rocchat_user_id') || '';
      localStorage.setItem(`rocchat_donor_${userId}`, tier);
      const recurringLine = donor.recurring ? '<br><span style="color:var(--turquoise)">Recurring supporter</span>' : '';
      const sinceLine = donor.donor_since ? `<br><span style="color:var(--text-tertiary)">Supporting since ${new Date(donor.donor_since * 1000).toLocaleDateString()}</span>` : '';
      display.innerHTML = `<span style="font-size:var(--text-sm)">${tierNames[tier]}</span>${recurringLine}${sinceLine}<br><span style="color:var(--text-tertiary)">Your feather badge is shown on your avatar</span>`;
    } else {
      display.textContent = 'No active badge — donate to earn your Roc Feather!';
    }
  } catch {
    display.textContent = 'Could not load badge status';
  }
}

async function loadQuietHours() {
  try {
    const res = await api.get('/features/quiet-hours');
    const data = res.data as { quiet_start: string | null; quiet_end: string | null; dnd_exceptions: string[]; alert_keywords: string[] };
    if (data.quiet_start) (document.getElementById('quiet-start') as HTMLInputElement).value = data.quiet_start;
    if (data.quiet_end) (document.getElementById('quiet-end') as HTMLInputElement).value = data.quiet_end;

    // Store keywords locally for client-side DND breakthrough checks
    localStorage.setItem('rocchat_alert_keywords', JSON.stringify(data.alert_keywords || []));

    const listEl = document.getElementById('dnd-exceptions-list');
    if (listEl) {
      if (!data.dnd_exceptions?.length) {
        listEl.innerHTML = '<div style="font-size:var(--text-xs);color:var(--text-tertiary)">No exceptions set</div>';
      } else {
        listEl.innerHTML = data.dnd_exceptions.map(uid =>
          `<div style="display:flex;align-items:center;gap:var(--sp-2);padding:4px 0">
            <span style="font-size:var(--text-sm);color:var(--text-primary)">${uid.slice(0, 8)}...</span>
            <button class="btn-secondary remove-dnd-exception" data-uid="${uid}" style="font-size:var(--text-xs);padding:2px 8px;color:var(--danger)">Remove</button>
          </div>`
        ).join('');
        listEl.querySelectorAll('.remove-dnd-exception').forEach(btn => {
          btn.addEventListener('click', async () => {
            const uid = (btn as HTMLElement).dataset.uid!;
            const current = await api.get('/features/quiet-hours');
            const exceptions: string[] = ((current.data as { dnd_exceptions: string[] }).dnd_exceptions || []).filter(e => e !== uid);
            await api.put('/features/quiet-hours', { dnd_exceptions: exceptions });
            loadQuietHours();
          });
        });
      }
    }

    // Render keyword alert pills
    const kwEl = document.getElementById('keyword-alerts-list');
    if (kwEl) {
      const keywords = data.alert_keywords || [];
      if (!keywords.length) {
        kwEl.innerHTML = '<div style="font-size:var(--text-xs);color:var(--text-tertiary)">No keywords set</div>';
      } else {
        kwEl.innerHTML = keywords.map(kw =>
          `<span style="display:inline-flex;align-items:center;gap:4px;background:var(--bg-primary);border:1px solid var(--border);border-radius:20px;padding:2px 10px;font-size:var(--text-xs);color:var(--text-primary)">${kw}<button class="remove-keyword" data-kw="${kw}" style="background:none;border:none;color:var(--danger);cursor:pointer;font-size:14px;padding:0;line-height:1">&times;</button></span>`
        ).join('');
        kwEl.querySelectorAll('.remove-keyword').forEach(btn => {
          btn.addEventListener('click', async () => {
            const kw = (btn as HTMLElement).dataset.kw!;
            const current = await api.get('/features/quiet-hours');
            const updated: string[] = ((current.data as { alert_keywords: string[] }).alert_keywords || []).filter(k => k !== kw);
            await api.put('/features/quiet-hours', { alert_keywords: updated });
            loadQuietHours();
          });
        });
      }
    }
  } catch {
    const listEl = document.getElementById('dnd-exceptions-list');
    if (listEl) listEl.innerHTML = '<div style="font-size:var(--text-xs);color:var(--text-tertiary)">Could not load</div>';
  }
}

function applyChatTheme(theme: string) {
  const root = document.documentElement;
  // Maps to actual CSS custom properties used in message bubbles and chat background
  const themes: Record<string, Record<string, string>> = {
    default: {},
    midnight: { '--bg-app': '#0a1628', '--bg-bubble-mine': 'rgba(26, 54, 93, 0.8)', '--bg-bubble-theirs': 'rgba(30, 41, 59, 0.9)' },
    forest: { '--bg-app': '#0a1f0a', '--bg-bubble-mine': 'rgba(20, 83, 45, 0.8)', '--bg-bubble-theirs': 'rgba(26, 46, 26, 0.9)' },
    sunset: { '--bg-app': '#1a0f05', '--bg-bubble-mine': 'rgba(124, 45, 18, 0.8)', '--bg-bubble-theirs': 'rgba(41, 32, 24, 0.9)' },
    ocean: { '--bg-app': '#042f2e', '--bg-bubble-mine': 'rgba(19, 78, 74, 0.8)', '--bg-bubble-theirs': 'rgba(26, 47, 46, 0.9)' },
    rose: { '--bg-app': '#1a0a10', '--bg-bubble-mine': 'rgba(131, 24, 67, 0.8)', '--bg-bubble-theirs': 'rgba(42, 21, 32, 0.9)' },
    lavender: { '--bg-app': '#0f0a1a', '--bg-bubble-mine': 'rgba(76, 29, 149, 0.8)', '--bg-bubble-theirs': 'rgba(30, 21, 48, 0.9)' },
    charcoal: { '--bg-app': '#111111', '--bg-bubble-mine': 'rgba(51, 51, 51, 0.9)', '--bg-bubble-theirs': 'rgba(34, 34, 34, 0.9)' },
  };
  // Reset
  ['--bg-app', '--bg-bubble-mine', '--bg-bubble-theirs'].forEach(p => root.style.removeProperty(p));
  const t = themes[theme];
  if (t) Object.entries(t).forEach(([k, v]) => root.style.setProperty(k, v));
}

async function showScheduledMessages() {
  const overlay = createOverlay();
  overlay.querySelector('.overlay-body')!.innerHTML = '<div style="text-align:center;padding:var(--sp-4)">Loading...</div>';

  try {
    const res = await api.getScheduledMessages();
    const msgs = res.ok ? (res.data as unknown as { id: string; conversation_id: string; scheduled_at: number }[]) : [];
    const body = overlay.querySelector('.overlay-body')!;
    if (msgs.length === 0) {
      body.innerHTML = `
        <div style="text-align:center;padding:var(--sp-8);color:var(--text-tertiary)">
          <div style="font-size:48px;margin-bottom:var(--sp-3)">📋</div>
          <p>No scheduled messages</p>
          <p style="font-size:var(--text-xs);margin-top:var(--sp-2)">Use the clock icon in the composer to schedule a message</p>
        </div>
      `;
    } else {
      body.innerHTML = msgs.map(m => `
        <div class="setting-row" style="padding:var(--sp-3)">
          <div>
            <div class="setting-label">Message to ${m.conversation_id.slice(0, 8)}...</div>
            <div class="setting-desc">Scheduled for ${new Date(m.scheduled_at * 1000).toLocaleString()}</div>
          </div>
          <button class="btn-secondary" style="font-size:var(--text-xs);color:var(--danger);border-color:var(--danger);padding:var(--sp-1) var(--sp-2)" data-cancel-scheduled="${m.id}">Cancel</button>
        </div>
      `).join('');
      body.querySelectorAll('[data-cancel-scheduled]').forEach(btn => {
        btn.addEventListener('click', async () => {
          const id = (btn as HTMLElement).dataset.cancelScheduled!;
          await api.deleteScheduledMessage(id);
          showToast('Scheduled message cancelled');
          showScheduledMessages();
        });
      });
    }
  } catch { showToast('Failed to load scheduled messages', 'error'); }
}

async function showFoldersManager() {
  const overlay = createOverlay();
  overlay.querySelector('.overlay-body')!.innerHTML = '<div style="text-align:center;padding:var(--sp-4)">Loading...</div>';

  try {
    const res = await api.getChatFolders();
    const folders = res.ok ? (res.data as unknown as api.ChatFolder[]) : [];
    const body = overlay.querySelector('.overlay-body')!;

    body.innerHTML = `
      ${folders.length === 0 ? `
        <div style="text-align:center;padding:var(--sp-6);color:var(--text-tertiary)">
          <div style="font-size:48px;margin-bottom:var(--sp-3)">📁</div>
          <p>No folders yet</p>
        </div>
      ` : folders.map(f => `
        <div class="setting-row" style="padding:var(--sp-3)">
          <div>
            <div class="setting-label">${f.icon} ${escHtml(f.name)}</div>
            <div class="setting-desc">${f.conversation_ids.length} conversation${f.conversation_ids.length !== 1 ? 's' : ''}</div>
          </div>
          <button class="btn-secondary" style="font-size:var(--text-xs);color:var(--danger);border-color:var(--danger);padding:var(--sp-1) var(--sp-2)" data-delete-folder="${f.id}">Delete</button>
        </div>
      `).join('')}
      <div style="padding:var(--sp-3)">
        <button class="btn-secondary" id="overlay-create-folder" style="width:100%">+ Create Folder</button>
      </div>
    `;

    body.querySelectorAll('[data-delete-folder]').forEach(btn => {
      btn.addEventListener('click', async () => {
        const id = (btn as HTMLElement).dataset.deleteFolder!;
        if (confirm('Delete this folder?')) {
          await api.deleteChatFolder(id);
          showToast('Folder deleted');
          showFoldersManager();
        }
      });
    });

    body.querySelector('#overlay-create-folder')?.addEventListener('click', () => {
      const name = prompt('Folder name:');
      if (name && name.trim()) {
        const icon = prompt('Folder icon (emoji):', '📁') || '📁';
        api.createChatFolder(name.trim(), icon).then(res => {
          if (res.ok) {
            showToast('Folder created');
            showFoldersManager();
          }
        });
      }
    });
  } catch { showToast('Failed to load folders', 'error'); }
}

async function showContactsManager() {
  const overlay = createOverlay();
  overlay.querySelector('.overlay-body')!.innerHTML = '<div style="text-align:center;padding:var(--sp-4)">Loading...</div>';

  try {
    const res = await api.getSavedContacts();
    const contacts = res.ok ? (res.data as unknown as api.SavedContact[]) : [];
    const body = overlay.querySelector('.overlay-body')!;
    const uid = localStorage.getItem('rocchat_user_id') || '';

    body.innerHTML = `
      ${contacts.length === 0 ? `
        <div style="text-align:center;padding:var(--sp-6);color:var(--text-tertiary)">
          <div style="font-size:48px;margin-bottom:var(--sp-3)">👤</div>
          <p>No saved contacts</p>
          <p style="font-size:var(--text-xs);margin-top:var(--sp-2)">Contacts are saved when you start conversations</p>
        </div>
      ` : contacts.map(c => {
        const name = c.nickname || c.display_name || c.username;
        const initials = name.split(' ').map((w: string) => w[0]).join('').slice(0, 2).toUpperCase();
        let avatarHtml: string;
        if (c.avatar_url) {
          const path = (c.avatar_url as string).startsWith('/api/') ? c.avatar_url : `/api${c.avatar_url}`;
          const sep = path.includes('?') ? '&' : '?';
          avatarHtml = `<div class="avatar" style="width:40px;height:40px;font-size:14px"><img src="${path}${sep}uid=${encodeURIComponent(c.contact_id)}" loading="lazy" decoding="async" style="width:100%;height:100%;border-radius:50%;object-fit:cover" onerror="this.parentElement.textContent='${initials}'" /></div>`;
        } else {
          avatarHtml = `<div class="avatar" style="width:40px;height:40px;font-size:14px">${initials}</div>`;
        }
        return `
          <div class="setting-row" style="padding:var(--sp-3)">
            <div style="display:flex;align-items:center;gap:var(--sp-3)">
              ${avatarHtml}
              <div>
                <div class="setting-label">${escHtml(name)}</div>
                <div class="setting-desc">@${escHtml(c.username)}${c.nickname ? ` · Nickname: ${escHtml(c.nickname)}` : ''}</div>
              </div>
            </div>
            <div style="display:flex;gap:var(--sp-2)">
              <button class="btn-secondary" style="font-size:var(--text-xs);padding:var(--sp-1) var(--sp-2)" data-edit-nickname="${c.contact_id}" data-current-nick="${escHtml(c.nickname || '')}">Nickname</button>
              <button class="btn-secondary" style="font-size:var(--text-xs);color:var(--danger);border-color:var(--danger);padding:var(--sp-1) var(--sp-2)" data-remove-contact="${c.contact_id}">Remove</button>
            </div>
          </div>
        `;
      }).join('')}
    `;

    body.querySelectorAll('[data-edit-nickname]').forEach(btn => {
      btn.addEventListener('click', async () => {
        const id = (btn as HTMLElement).dataset.editNickname!;
        const current = (btn as HTMLElement).dataset.currentNick || '';
        const nickname = prompt('Set nickname (leave empty to clear):', current);
        if (nickname === null) return;
        await api.saveContact(id, nickname || undefined);
        showToast(nickname ? 'Nickname set' : 'Nickname cleared');
        showContactsManager();
      });
    });

    body.querySelectorAll('[data-remove-contact]').forEach(btn => {
      btn.addEventListener('click', async () => {
        const id = (btn as HTMLElement).dataset.removeContact!;
        if (confirm('Remove this contact?')) {
          await api.removeSavedContact(id);
          showToast('Contact removed');
          showContactsManager();
        }
      });
    });
  } catch { showToast('Failed to load contacts', 'error'); }
}

function createOverlay(): HTMLElement {
  // Remove existing overlay
  document.querySelector('.settings-overlay')?.remove();

  const overlay = document.createElement('div');
  overlay.className = 'settings-overlay';
  overlay.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,0.5);z-index:50;display:flex;align-items:center;justify-content:center;padding:var(--sp-4)';

  overlay.innerHTML = `
    <div style="background:var(--bg-elevated);border-radius:var(--radius-xl);max-width:480px;width:100%;max-height:80vh;display:flex;flex-direction:column;box-shadow:var(--shadow-xl)">
      <div style="display:flex;justify-content:flex-end;padding:var(--sp-3)">
        <button class="icon-btn overlay-close" style="width:32px;height:32px" aria-label="Close">✕</button>
      </div>
      <div class="overlay-body" style="overflow-y:auto;padding:0 var(--sp-4) var(--sp-4)"></div>
    </div>
  `;

  overlay.querySelector('.overlay-close')?.addEventListener('click', () => overlay.remove());
  overlay.addEventListener('click', (e) => { if (e.target === overlay) overlay.remove(); });
  document.body.appendChild(overlay);
  return overlay;
}

async function loadBusinessState() {
  try {
    const res = await api.getMe();
    if (!res.ok) return;
    const user = res.data as unknown as Record<string, unknown>;
    const tier = (user.account_tier as string) || 'premium';

    if (tier === 'business') {
      // Show dashboard, hide upgrade prompt
      const content = document.getElementById('business-content');
      const dashboard = document.getElementById('business-dashboard');
      if (content) content.style.display = 'none';
      if (dashboard) dashboard.style.display = 'block';
      loadBusinessDashboard();
    }
  } catch { /* silent */ }
}

async function loadBusinessDashboard() {
  const orgList = document.getElementById('org-list');
  if (!orgList) return;

  try {
    const res = await api.getOrganizations();
    const orgs = res.ok ? (res.data as unknown as api.Organization[]) : [];

    if (orgs.length === 0) {
      orgList.innerHTML = `
        <div style="text-align:center;padding:var(--sp-4);color:var(--text-tertiary)">
          <p>No organizations yet. Create one to get started.</p>
        </div>
      `;
    } else {
      orgList.innerHTML = orgs.map(o => `
        <div class="setting-row" style="padding:var(--sp-3);cursor:pointer" data-org-id="${o.id}">
          <div>
            <div class="setting-label" style="display:flex;align-items:center;gap:var(--sp-2)">
              <span style="width:28px;height:28px;border-radius:var(--radius-md);background:${escHtml(o.accent_color)};display:flex;align-items:center;justify-content:center;font-size:12px;color:white;font-weight:700">${escHtml(o.name[0])}</span>
              ${escHtml(o.name)}
            </div>
            <div class="setting-desc">Role: ${escHtml(o.role)} · Created ${new Date(o.created_at * 1000).toLocaleDateString()}</div>
          </div>
        </div>
      `).join('');

      orgList.querySelectorAll('[data-org-id]').forEach(el => {
        el.addEventListener('click', () => {
          const orgId = (el as HTMLElement).dataset.orgId!;
          showOrgDashboard(orgId);
        });
      });
    }
  } catch { showToast('Failed to load organizations', 'error'); }
}

async function showOrgDashboard(orgId: string) {
  const overlay = createOverlay();
  overlay.querySelector('.overlay-body')!.innerHTML = '<div style="text-align:center;padding:var(--sp-4)">Loading...</div>';

  try {
    const res = await api.getOrganization(orgId);
    if (!res.ok) { showToast('Failed to load org', 'error'); return; }
    const org = res.data as unknown as api.Organization & { members: api.OrgMember[] };
    const body = overlay.querySelector('.overlay-body')!;

    body.innerHTML = `
      <h3 style="margin-bottom:var(--sp-3)">${escHtml(org.name)}</h3>

      <div style="margin-bottom:var(--sp-4)">
        <div style="font-weight:600;margin-bottom:var(--sp-2)">Members (${org.members.length})</div>
        ${org.members.map(m => {
          const name = m.display_name || m.username;
          const initials = name.split(' ').map((w: string) => w[0]).join('').slice(0, 2).toUpperCase();
          let avatarHtml: string;
          if (m.avatar_url) {
            const path = (m.avatar_url as string).startsWith('/api/') ? m.avatar_url : `/api${m.avatar_url}`;
            const sep = path.includes('?') ? '&' : '?';
            avatarHtml = `<div class="avatar" style="width:32px;height:32px;font-size:12px"><img src="${path}${sep}uid=${encodeURIComponent(m.user_id)}" loading="lazy" decoding="async" style="width:100%;height:100%;border-radius:50%;object-fit:cover" onerror="this.parentElement.textContent='${initials}'" /></div>`;
          } else {
            avatarHtml = `<div class="avatar" style="width:32px;height:32px;font-size:12px">${initials}</div>`;
          }
          return `
            <div class="setting-row" style="padding:var(--sp-2)">
              <div style="display:flex;align-items:center;gap:var(--sp-2)">
                ${avatarHtml}
                <div>
                  <div style="font-size:var(--text-sm);font-weight:500">${escHtml(name)}</div>
                  <div style="font-size:var(--text-xs);color:var(--text-tertiary)">${escHtml(m.role)}</div>
                </div>
              </div>
              ${m.role !== 'owner' ? `<button class="btn-secondary" style="font-size:var(--text-xs);color:var(--danger);border-color:var(--danger);padding:2px 8px" data-remove-member="${m.user_id}">Remove</button>` : ''}
            </div>
          `;
        }).join('')}
      </div>

      <div style="display:grid;gap:var(--sp-2)">
        <button class="btn-secondary" id="org-add-member">+ Add Member</button>
        <button class="btn-secondary" id="org-bulk-add">👥 Bulk Provision Users</button>
        <button class="btn-secondary" id="org-sso">🔐 SSO Configuration</button>
        <button class="btn-secondary" id="org-export">📊 Compliance Export</button>
        <button class="btn-secondary" id="org-retention">⏱ Retention Policy</button>
        <button class="btn-secondary" id="org-wipe" style="color:var(--danger);border-color:var(--danger)">🗑 Remote Device Wipe</button>
        <button class="btn-secondary" id="org-directory">🔍 User Directory</button>
        <button class="btn-secondary" id="org-api-keys">🔑 API Keys</button>
        <button class="btn-secondary" id="org-webhooks">🔗 Webhooks</button>
      </div>
    `;

    // Remove member
    body.querySelectorAll('[data-remove-member]').forEach(btn => {
      btn.addEventListener('click', async () => {
        const uid = (btn as HTMLElement).dataset.removeMember!;
        if (confirm('Remove this member?')) {
          await api.removeOrgMember(orgId, uid);
          showToast('Member removed');
          showOrgDashboard(orgId);
        }
      });
    });

    // Add member
    body.querySelector('#org-add-member')?.addEventListener('click', async () => {
      const username = prompt('Enter username to add:');
      if (!username) return;
      const searchRes = await api.searchUsers(username.trim());
      if (!searchRes.ok || !(searchRes.data as unknown as { results: api.UserResult[] }).results?.length) {
        showToast('User not found', 'error');
        return;
      }
      const user = (searchRes.data as unknown as { results: api.UserResult[] }).results[0];
      const addRes = await api.addOrgMember(orgId, user.userId);
      if (addRes.ok) {
        showToast(`${user.displayName || user.username} added`);
        showOrgDashboard(orgId);
      } else {
        showToast('Failed to add member', 'error');
      }
    });

    // Bulk provision
    body.querySelector('#org-bulk-add')?.addEventListener('click', async () => {
      const input = prompt('Enter usernames to add (comma-separated):');
      if (!input) return;
      const usernames = input.split(',').map(u => u.trim()).filter(Boolean);
      if (usernames.length === 0) return;
      if (usernames.length > 200) {
        showToast('Maximum 200 users per bulk operation', 'error');
        return;
      }
      const users = usernames.map(username => ({ username, role: 'member' }));
      const res = await api.bulkAddOrgMembers(orgId, users);
      if (res.ok) {
        const data = res.data as unknown as { added: number; total: number };
        showToast(`Added ${data.added} of ${data.total} users`);
        showOrgDashboard(orgId);
      } else {
        showToast('Bulk provision failed', 'error');
      }
    });

    // SSO configuration
    body.querySelector('#org-sso')?.addEventListener('click', async () => {
      const ssoRes = await api.getSsoConfig(orgId);
      const current = ssoRes.ok ? (ssoRes.data as unknown as { provider: string; issuer_url: string; client_id: string; redirect_uri: string; enabled: number }) : { provider: 'oidc', issuer_url: '', client_id: '', redirect_uri: '', enabled: 0 };

      const ssoOverlay = createOverlay();
      ssoOverlay.querySelector('.overlay-body')!.innerHTML = `
        <h3 style="margin-bottom:var(--sp-3)">SSO Configuration</h3>
        <div style="display:grid;gap:var(--sp-3)">
          <div>
            <label class="setting-label" style="display:block;margin-bottom:4px">Provider</label>
            <select class="form-input" id="sso-provider" style="width:100%">
              <option value="oidc" ${current.provider === 'oidc' ? 'selected' : ''}>OpenID Connect (OIDC)</option>
              <option value="saml" ${current.provider === 'saml' ? 'selected' : ''}>SAML 2.0</option>
            </select>
          </div>
          <div>
            <label class="setting-label" style="display:block;margin-bottom:4px">Issuer URL</label>
            <input class="form-input" id="sso-issuer" style="width:100%" placeholder="https://accounts.google.com" value="${escHtml(current.issuer_url)}" />
          </div>
          <div>
            <label class="setting-label" style="display:block;margin-bottom:4px">Client ID</label>
            <input class="form-input" id="sso-client-id" style="width:100%" placeholder="your-client-id" value="${escHtml(current.client_id)}" />
          </div>
          <div>
            <label class="setting-label" style="display:block;margin-bottom:4px">Client Secret</label>
            <input class="form-input" id="sso-client-secret" type="password" style="width:100%" placeholder="your-client-secret" />
          </div>
          <div>
            <label class="setting-label" style="display:block;margin-bottom:4px">Redirect URI</label>
            <input class="form-input" id="sso-redirect" style="width:100%" placeholder="https://chat.mocipher.com/sso/callback" value="${escHtml(current.redirect_uri)}" />
          </div>
          <label style="display:flex;align-items:center;gap:var(--sp-2);cursor:pointer">
            <input type="checkbox" id="sso-enabled" ${current.enabled ? 'checked' : ''} />
            <span>Enable SSO</span>
          </label>
          <div style="display:flex;gap:var(--sp-2)">
            <button class="btn-primary" id="sso-save" style="flex:1">Save</button>
            <button class="btn-secondary" id="sso-remove" style="flex:1;color:var(--danger);border-color:var(--danger)">Remove</button>
          </div>
        </div>
      `;

      ssoOverlay.querySelector('#sso-save')?.addEventListener('click', async () => {
        const issuerUrl = (ssoOverlay.querySelector('#sso-issuer') as HTMLInputElement).value.trim();
        const clientId = (ssoOverlay.querySelector('#sso-client-id') as HTMLInputElement).value.trim();
        const clientSecret = (ssoOverlay.querySelector('#sso-client-secret') as HTMLInputElement).value.trim();
        const redirectUri = (ssoOverlay.querySelector('#sso-redirect') as HTMLInputElement).value.trim();
        const provider = (ssoOverlay.querySelector('#sso-provider') as HTMLSelectElement).value;
        const enabled = (ssoOverlay.querySelector('#sso-enabled') as HTMLInputElement).checked;

        if (!issuerUrl || !clientId || !clientSecret || !redirectUri) {
          showToast('All fields are required', 'error');
          return;
        }
        const saveRes = await api.setSsoConfig(orgId, { provider, issuer_url: issuerUrl, client_id: clientId, client_secret: clientSecret, redirect_uri: redirectUri, enabled });
        if (saveRes.ok) {
          showToast('SSO configuration saved');
          ssoOverlay.remove();
        } else {
          showToast('Failed to save SSO config', 'error');
        }
      });

      ssoOverlay.querySelector('#sso-remove')?.addEventListener('click', async () => {
        if (!confirm('Remove SSO configuration?')) return;
        await api.deleteSsoConfig(orgId);
        showToast('SSO configuration removed');
        ssoOverlay.remove();
      });
    });

    // Compliance export
    body.querySelector('#org-export')?.addEventListener('click', async () => {
      const exportRes = await api.getComplianceExport(orgId);
      if (exportRes.ok) {
        const blob = new Blob([JSON.stringify(exportRes.data, null, 2)], { type: 'application/json' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `rocchat-export-${orgId.slice(0, 8)}-${Date.now()}.json`;
        a.click();
        URL.revokeObjectURL(url);
        showToast('Export downloaded');
      }
    });

    // Retention policy
    body.querySelector('#org-retention')?.addEventListener('click', async () => {
      const retRes = await api.getRetentionPolicy(orgId);
      const current = retRes.ok ? (retRes.data as unknown as { max_age_days: number; auto_delete: number }) : { max_age_days: 365, auto_delete: 0 };
      const days = prompt(`Message retention (days, current: ${current.max_age_days}):`, String(current.max_age_days));
      if (!days) return;
      const autoDelete = confirm('Auto-delete messages older than this?');
      await api.setRetentionPolicy(orgId, parseInt(days, 10), autoDelete);
      showToast('Retention policy updated');
    });

    // Remote wipe
    body.querySelector('#org-wipe')?.addEventListener('click', async () => {
      const username = prompt('Username of user to wipe device:');
      if (!username) return;
      const searchRes = await api.searchUsers(username.trim());
      if (!searchRes.ok || !(searchRes.data as unknown as { results: api.UserResult[] }).results?.length) {
        showToast('User not found', 'error');
        return;
      }
      const user = (searchRes.data as unknown as { results: api.UserResult[] }).results[0];
      const deviceId = prompt('Device ID to wipe:');
      if (!deviceId) return;
      if (!confirm(`WIPE device ${deviceId} for ${user.username}? This cannot be undone.`)) return;
      const wipeRes = await api.wipeDevice(orgId, user.userId, deviceId);
      if (wipeRes.ok) {
        showToast('Device wiped successfully');
      } else {
        showToast('Failed to wipe device', 'error');
      }
    });

    // Org directory
    body.querySelector('#org-directory')?.addEventListener('click', async () => {
      const q = prompt('Search members (leave blank to show all):') || '';
      const res = await api.searchOrgDirectory(orgId, q);
      const members = (res.data || []) as Record<string, string>[];
      const list = members.map(m =>
        `${m.display_name || m.username} (@${m.username}) — ${m.role}`
      ).join('\n');
      alert(list || 'No members found');
    });

    // API Keys
    body.querySelector('#org-api-keys')?.addEventListener('click', async () => {
      const overlay = createOverlay();
      const ob = overlay.querySelector('.overlay-body')!;
      const renderKeys = async () => {
        const res = await api.listApiKeys(orgId);
        const keys = (res.data || []) as Record<string, string>[];
        ob.innerHTML = `
          <h3 style="margin-bottom:var(--sp-3)">🔑 API Keys</h3>
          <div style="display:grid;gap:var(--sp-2);margin-bottom:var(--sp-3)">
            ${keys.map((k: any) => `
              <div style="display:flex;justify-content:space-between;align-items:center;padding:var(--sp-2);background:var(--bg-tertiary);border-radius:8px">
                <div>
                  <div style="font-size:14px;font-weight:600">${escHtml(k.name)}</div>
                  <div style="font-size:12px;color:var(--text-tertiary)">${escHtml(k.key_prefix)}... · ${k.scopes}</div>
                </div>
                <button class="btn-secondary revoke-key" data-kid="${k.id}" style="font-size:12px;color:var(--danger);border-color:var(--danger)">Revoke</button>
              </div>
            `).join('') || '<p style="color:var(--text-tertiary)">No API keys yet</p>'}
          </div>
          <button class="btn-primary" id="create-api-key" style="width:100%">+ Create New Key</button>
        `;
        ob.querySelectorAll('.revoke-key').forEach(btn => {
          btn.addEventListener('click', async () => {
            const kid = (btn as HTMLElement).dataset.kid!;
            if (confirm('Revoke this API key? This cannot be undone.')) {
              await api.revokeApiKey(orgId, kid);
              showToast('Key revoked');
              renderKeys();
            }
          });
        });
        ob.querySelector('#create-api-key')?.addEventListener('click', async () => {
          const name = prompt('Key name (e.g. "Production Integration"):');
          if (!name) return;
          const res2 = await api.createApiKey(orgId, name);
          const data = res2.data;
          if (data?.key) {
            prompt(`Copy your API key now — it won't be shown again:`, data.key);
          }
          renderKeys();
        });
      };
      renderKeys();
    });

    // Webhooks
    body.querySelector('#org-webhooks')?.addEventListener('click', async () => {
      const overlay = createOverlay();
      const ob = overlay.querySelector('.overlay-body')!;
      const renderHooks = async () => {
        const res = await api.listWebhooks(orgId);
        const hooks = (res.data || []) as Record<string, string>[];
        ob.innerHTML = `
          <h3 style="margin-bottom:var(--sp-3)">🔗 Webhooks</h3>
          <div style="display:grid;gap:var(--sp-2);margin-bottom:var(--sp-3)">
            ${hooks.map((h: any) => `
              <div style="display:flex;justify-content:space-between;align-items:center;padding:var(--sp-2);background:var(--bg-tertiary);border-radius:8px">
                <div>
                  <div style="font-size:13px;font-weight:600;word-break:break-all">${escHtml(h.url)}</div>
                  <div style="font-size:11px;color:var(--text-tertiary)">${h.events}</div>
                </div>
                <button class="btn-secondary remove-hook" data-hid="${h.id}" style="font-size:12px;color:var(--danger);border-color:var(--danger)">Remove</button>
              </div>
            `).join('') || '<p style="color:var(--text-tertiary)">No webhooks registered</p>'}
          </div>
          <button class="btn-primary" id="create-webhook" style="width:100%">+ Add Webhook</button>
        `;
        ob.querySelectorAll('.remove-hook').forEach(btn => {
          btn.addEventListener('click', async () => {
            const hid = (btn as HTMLElement).dataset.hid!;
            if (confirm('Remove this webhook?')) {
              await api.deleteWebhook(orgId, hid);
              showToast('Webhook removed');
              renderHooks();
            }
          });
        });
        ob.querySelector('#create-webhook')?.addEventListener('click', async () => {
          const url2 = prompt('Webhook URL (must start with https://):');
          if (!url2) return;
          const res2 = await api.createWebhook(orgId, url2);
          const data = res2.data;
          if (data?.signing_secret) {
            prompt(`Save your signing secret — it won't be shown again:`, data.signing_secret);
          }
          renderHooks();
        });
      };
      renderHooks();
    });

  } catch { showToast('Failed to load organization', 'error'); }
}

async function loadProfile() {
  try {
    const res = await api.getMe();
    if (res.ok) {
      const user = res.data as unknown as Record<string, unknown>;
      // Cache display name & avatar for sidebar
      if (user.display_name) localStorage.setItem('rocchat_display_name', user.display_name as string);
      else if (user.username) localStorage.setItem('rocchat_display_name', user.username as string);
      if (user.avatar_url) localStorage.setItem('rocchat_avatar_url', user.avatar_url as string);
      else localStorage.removeItem('rocchat_avatar_url');
      const usernameEl = document.getElementById('setting-username');
      const nameEl = document.getElementById('setting-display-name');
      const keyEl = document.getElementById('identity-key-display');
      const toggle = document.getElementById('toggle-discoverable') as HTMLInputElement;
      const avatarEl = document.getElementById('profile-avatar');
      const removeBtn = document.getElementById('remove-avatar-btn') as HTMLElement;

      if (usernameEl) usernameEl.textContent = `@${user.username}`;
      if (nameEl) nameEl.textContent = (user.display_name as string) || (user.username as string);
      if (keyEl) keyEl.textContent = (user.identity_key as string) || 'Not available';
      if (toggle) toggle.checked = !!user.discoverable;

      // Status text
      const statusEl = document.getElementById('setting-status');
      if (statusEl) {
        const st = (user.status_text as string) || '';
        statusEl.textContent = st || 'Set a status...';
        statusEl.dataset.status = st;
      }

      // Avatar
      if (avatarEl) {
        const displayName = (user.display_name as string) || (user.username as string) || '?';
        const initials = displayName.split(' ').map((w: string) => w[0]).join('').slice(0, 2).toUpperCase();
        if (user.avatar_url) {
          const uid = user.id || localStorage.getItem('rocchat_user_id') || '';
          const avatarPath = (user.avatar_url as string).startsWith('/api/') ? (user.avatar_url as string) : `${api.getApiBase()}${user.avatar_url}`;
          const sep = avatarPath.includes('?') ? '&' : '?';
          avatarEl.innerHTML = `<img src="${avatarPath}${sep}uid=${encodeURIComponent(uid as string)}" alt="${escHtml(displayName)}" style="width:100%;height:100%;object-fit:cover;border-radius:50%" />`;
          if (removeBtn) removeBtn.style.display = 'inline-flex';
        } else {
          avatarEl.textContent = initials;
          if (removeBtn) removeBtn.style.display = 'none';
        }
      }

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
      const lastSeen = document.getElementById('last-seen-visibility') as HTMLSelectElement;
      if (lastSeen && user.show_last_seen_to) lastSeen.value = user.show_last_seen_to as string;
      const photoVis = document.getElementById('photo-visibility') as HTMLSelectElement;
      if (photoVis && user.show_photo_to) photoVis.value = user.show_photo_to as string;
      const screenshotDetect = document.getElementById('toggle-screenshot-detect') as HTMLInputElement;
      if (screenshotDetect) screenshotDetect.checked = user.screenshot_detection !== 0;
      const appLock = document.getElementById('toggle-app-lock') as HTMLInputElement;
      if (appLock) appLock.checked = !!localStorage.getItem('rocchat_app_lock_pin');

      // Ghost Mode: detect if all ghost settings are active
      const ghostToggle = document.getElementById('toggle-ghost-mode') as HTMLInputElement;
      if (ghostToggle) {
        const isGhost = user.show_read_receipts === 0 && user.show_typing_indicator === 0 && user.show_online_to === 'nobody';
        ghostToggle.checked = isGhost || !!localStorage.getItem('rocchat_ghost_mode');
      }
    }
  } catch {}
}

// ── Blocked Contacts Dialog ──
async function showBlockedContactsDialog() {
  const overlay = document.createElement('div');
  overlay.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,0.6);z-index:1000;display:flex;align-items:center;justify-content:center';
  const dialog = document.createElement('div');
  dialog.style.cssText = 'background:var(--bg-secondary);border-radius:var(--radius-lg);padding:var(--sp-6);width:90%;max-width:400px;max-height:70vh;overflow-y:auto';
  dialog.innerHTML = `<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:var(--sp-4)">
    <h3 style="margin:0;color:var(--text-primary)">Blocked Contacts</h3>
    <button id="close-blocked" style="background:none;border:none;color:var(--text-tertiary);font-size:24px;cursor:pointer">&times;</button>
  </div>
  <div id="blocked-list" style="color:var(--text-secondary)">Loading...</div>`;
  overlay.appendChild(dialog);
  document.body.appendChild(overlay);
  overlay.addEventListener('click', (e) => { if (e.target === overlay) overlay.remove(); });
  dialog.querySelector('#close-blocked')!.addEventListener('click', () => overlay.remove());

  try {
    const res = await api.req<Array<{ user_id: string; display_name: string }>>('/contacts/blocked');
    const list = dialog.querySelector('#blocked-list')!;
    const contacts = res?.data;
    if (!contacts || contacts.length === 0) {
      list.innerHTML = '<p style="text-align:center;color:var(--text-tertiary);padding:var(--sp-6) 0">No blocked contacts</p>';
      return;
    }
    list.innerHTML = '';
    for (const c of contacts) {
      const row = document.createElement('div');
      row.style.cssText = 'display:flex;justify-content:space-between;align-items:center;padding:var(--sp-3);border-bottom:1px solid var(--border-color)';
      row.innerHTML = `<span style="color:var(--text-primary)">${escapeHtml(c.display_name || c.user_id)}</span>
        <button class="btn-secondary" style="font-size:var(--text-xs);padding:var(--sp-1) var(--sp-3)" data-uid="${escapeHtml(c.user_id)}">Unblock</button>`;
      row.querySelector('button')!.addEventListener('click', async (e) => {
        const btn = e.target as HTMLButtonElement;
        btn.disabled = true;
        btn.textContent = '...';
        await api.blockContact(c.user_id, false);
        row.remove();
        if (!list.children.length) list.innerHTML = '<p style="text-align:center;color:var(--text-tertiary);padding:var(--sp-6) 0">No blocked contacts</p>';
      });
      list.appendChild(row);
    }
  } catch {
    dialog.querySelector('#blocked-list')!.innerHTML = '<p style="color:var(--text-tertiary)">Could not load blocked contacts</p>';
  }
}

function escapeHtml(s: string): string {
  const d = document.createElement('div');
  d.textContent = s;
  return d.innerHTML;
}

// ── App Lock PIN Setup ──
function showAppLockSetup() {
  const overlay = document.createElement('div');
  overlay.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,0.6);z-index:1000;display:flex;align-items:center;justify-content:center';
  const dialog = document.createElement('div');
  dialog.style.cssText = 'background:var(--bg-secondary);border-radius:var(--radius-lg);padding:var(--sp-6);width:90%;max-width:340px;text-align:center';
  dialog.innerHTML = `<h3 style="margin:0 0 var(--sp-3);color:var(--text-primary)">Set App Lock PIN</h3>
    <p style="font-size:var(--text-sm);color:var(--text-tertiary);margin-bottom:var(--sp-4)">Enter a 4-6 digit PIN to lock RocChat</p>
    <input type="password" inputmode="numeric" pattern="[0-9]*" id="pin-input" maxlength="6" placeholder="Enter PIN" autocomplete="off" style="width:100%;padding:var(--sp-3);font-size:var(--text-lg);text-align:center;border:1px solid var(--border-color);border-radius:var(--radius);background:var(--bg-primary);color:var(--text-primary);letter-spacing:8px;margin-bottom:var(--sp-3)" />
    <input type="password" inputmode="numeric" pattern="[0-9]*" id="pin-confirm" maxlength="6" placeholder="Confirm PIN" autocomplete="off" style="width:100%;padding:var(--sp-3);font-size:var(--text-lg);text-align:center;border:1px solid var(--border-color);border-radius:var(--radius);background:var(--bg-primary);color:var(--text-primary);letter-spacing:8px;margin-bottom:var(--sp-4)" />
    <div style="display:flex;gap:var(--sp-3);justify-content:center">
      <button class="btn-secondary" id="pin-cancel">Cancel</button>
      <button class="btn-primary" id="pin-save">Save</button>
    </div>`;
  overlay.appendChild(dialog);
  document.body.appendChild(overlay);
  overlay.addEventListener('click', (e) => { if (e.target === overlay) { cancelLock(); } });
  dialog.querySelector('#pin-cancel')!.addEventListener('click', cancelLock);
  dialog.querySelector('#pin-save')!.addEventListener('click', () => {
    const pin = (dialog.querySelector('#pin-input') as HTMLInputElement).value;
    const confirm = (dialog.querySelector('#pin-confirm') as HTMLInputElement).value;
    if (pin.length < 4 || !/^\d+$/.test(pin)) {
      showToast('PIN must be 4-6 digits', 'error');
      return;
    }
    if (pin !== confirm) {
      showToast('PINs do not match', 'error');
      return;
    }
    // Store hash in localStorage (for client-side lock only)
    crypto.subtle.digest('SHA-256', new TextEncoder().encode(pin)).then(hash => {
      const hex = Array.from(new Uint8Array(hash)).map(b => b.toString(16).padStart(2, '0')).join('');
      localStorage.setItem('rocchat_app_lock_pin', hex);
      overlay.remove();
      showToast('App lock enabled', 'success');
    });
  });

  function cancelLock() {
    const toggle = document.getElementById('toggle-app-lock') as HTMLInputElement;
    if (toggle) toggle.checked = false;
    overlay.remove();
  }
}

// ── App Lock Challenge (on app start) ──
export function checkAppLock(): boolean {
  const pinHash = localStorage.getItem('rocchat_app_lock_pin');
  if (!pinHash) return true; // no lock
  return false; // locked
}

export function showAppLockScreen(onUnlock: () => void) {
  const overlay = document.createElement('div');
  overlay.id = 'app-lock-overlay';
  overlay.style.cssText = 'position:fixed;inset:0;background:var(--bg-primary);z-index:9999;display:flex;align-items:center;justify-content:center;flex-direction:column';
  overlay.innerHTML = `<div style="text-align:center;width:90%;max-width:300px">
    <div style="font-size:48px;margin-bottom:var(--sp-4)">🔒</div>
    <h2 style="color:var(--text-primary);margin-bottom:var(--sp-4)">RocChat Locked</h2>
    <input type="password" inputmode="numeric" pattern="[0-9]*" id="lock-pin-input" maxlength="6" placeholder="Enter PIN" autocomplete="off" style="width:100%;padding:var(--sp-3);font-size:var(--text-lg);text-align:center;border:1px solid var(--border-color);border-radius:var(--radius);background:var(--bg-secondary);color:var(--text-primary);letter-spacing:8px;margin-bottom:var(--sp-4)" />
    <button class="btn-primary" id="lock-unlock-btn" style="width:100%">Unlock</button>
    <p id="lock-error" style="color:red;font-size:var(--text-sm);margin-top:var(--sp-2);display:none">Wrong PIN</p>
  </div>`;
  document.body.appendChild(overlay);

  const savedHash = localStorage.getItem('rocchat_app_lock_pin')!;
  overlay.querySelector('#lock-unlock-btn')!.addEventListener('click', async () => {
    const pin = (overlay.querySelector('#lock-pin-input') as HTMLInputElement).value;
    const hash = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(pin));
    const hex = Array.from(new Uint8Array(hash)).map(b => b.toString(16).padStart(2, '0')).join('');
    if (hex === savedHash) {
      overlay.remove();
      onUnlock();
    } else {
      overlay.querySelector('#lock-error')!.setAttribute('style', 'color:red;font-size:var(--text-sm);margin-top:var(--sp-2)');
    }
  });
  overlay.querySelector('#lock-pin-input')!.addEventListener('keydown', (e) => {
    if ((e as KeyboardEvent).key === 'Enter') (overlay.querySelector('#lock-unlock-btn') as HTMLButtonElement).click();
  });
}

export function applyTheme(theme: string) {
  const root = document.documentElement;
  root.classList.remove('dark', 'light');
  if (theme === 'dark') root.classList.add('dark');
  else if (theme === 'light') root.classList.add('light');
  else if (theme === 'scheduled') {
    const darkStart = localStorage.getItem('rocchat_theme_dark_start') || '20:00';
    const darkEnd = localStorage.getItem('rocchat_theme_dark_end') || '07:00';
    const now = new Date();
    const nowMins = now.getHours() * 60 + now.getMinutes();
    const [sh, sm] = darkStart.split(':').map(Number);
    const [eh, em] = darkEnd.split(':').map(Number);
    const startMins = sh * 60 + sm;
    const endMins = eh * 60 + em;
    const isDark = startMins < endMins
      ? nowMins >= startMins && nowMins < endMins
      : nowMins >= startMins || nowMins < endMins;
    root.classList.add(isDark ? 'dark' : 'light');
  }
  // 'auto' = no class, handled by @media query

  // Also apply chat theme
  const chatTheme = localStorage.getItem('rocchat_chat_theme') || 'default';
  applyChatTheme(chatTheme);
}

// Check scheduled theme every minute
setInterval(() => {
  const theme = localStorage.getItem('rocchat_theme');
  if (theme === 'scheduled') applyTheme('scheduled');
}, 60_000);

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

// ── Key transfer: Source device (has keys, sends them) ──────────────
async function handleKeyTransferAsSource(requestId: string, remoteEphemeralPub: string) {
  try {
    // Generate our ephemeral X25519 key pair
    const ephemeral = await crypto.subtle.generateKey({ name: 'X25519' } as any, true, ['deriveBits']) as CryptoKeyPair;
    const ephPubRaw = await crypto.subtle.exportKey('raw', ephemeral.publicKey);
    const ephPubB64 = btoa(String.fromCharCode(...new Uint8Array(ephPubRaw)));

    // Import remote ephemeral public key
    const remotePubBytes = Uint8Array.from(atob(remoteEphemeralPub), (c) => c.charCodeAt(0));
    const remotePubKey = await crypto.subtle.importKey('raw', remotePubBytes, { name: 'X25519' } as any, false, []);

    // ECDH → shared secret → HKDF → AES key
    const sharedBits = await crypto.subtle.deriveBits(
      { name: 'X25519', public: remotePubKey } as any,
      ephemeral.privateKey,
      256,
    );
    const aesKey = await crypto.subtle.importKey('raw', sharedBits, 'HKDF', false, ['deriveKey']);
    const encKey = await crypto.subtle.deriveKey(
      { name: 'HKDF', hash: 'SHA-256', salt: new Uint8Array(0), info: new TextEncoder().encode('rocchat-key-transfer') },
      aesKey,
      { name: 'AES-GCM', length: 256 },
      false,
      ['encrypt'],
    );

    // Gather local key material
    const { getSecretString } = await import('../crypto/secure-store.js');
    const identityPriv = (await getSecretString('rocchat_identity_priv')) || localStorage.getItem('rocchat_identity_priv') || '';
    const identityPub = localStorage.getItem('rocchat_identity_pub') || '';
    const encryptedKeys = (await getSecretString('rocchat_keys')) || '';

    const keyBundle = JSON.stringify({
      identityPriv,
      identityPub,
      encryptedKeys,
    });

    // Encrypt with ECDH-derived key
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, encKey, new TextEncoder().encode(keyBundle));
    const combined = new Uint8Array(12 + ct.byteLength);
    combined.set(iv, 0);
    combined.set(new Uint8Array(ct), 12);
    const encryptedBundle = btoa(String.fromCharCode(...combined));

    // Upload to server
    await api.uploadKeyBundle(requestId, encryptedBundle, ephPubB64);
  } catch (err) {
    console.error('Key transfer (source) failed:', err);
    showToast('Key transfer failed', 'error');
  }
}

// ── Key transfer: New device (requests keys, receives them) ─────────
async function requestKeyTransferAsNewDevice() {
  try {
    // Generate ephemeral X25519 key pair
    const ephemeral = await crypto.subtle.generateKey({ name: 'X25519' } as any, true, ['deriveBits']) as CryptoKeyPair;
    const ephPubRaw = await crypto.subtle.exportKey('raw', ephemeral.publicKey);
    const ephPubB64 = btoa(String.fromCharCode(...new Uint8Array(ephPubRaw)));

    // Send request
    const res = await api.requestKeyTransfer(ephPubB64);
    if (!res.ok) { showToast('Key transfer request failed', 'error'); return; }
    const { requestId } = res.data;

    showToast('Waiting for source device to approve...');

    // Poll for bundle (up to 60 seconds)
    let attempts = 0;
    const pollTimer = setInterval(async () => {
      attempts++;
      if (attempts > 30) {
        clearInterval(pollTimer);
        showToast('Key transfer timed out', 'error');
        return;
      }
      try {
        const bundle = await api.fetchKeyBundle(requestId);
        if (bundle.ok && bundle.data.ready && bundle.data.encryptedBundle && bundle.data.ephemeralPub) {
          clearInterval(pollTimer);
          await receiveKeyBundle(ephemeral.privateKey, bundle.data.ephemeralPub, bundle.data.encryptedBundle);
        }
      } catch { /* retry */ }
    }, 2000);
  } catch (err) {
    console.error('Key transfer (new device) failed:', err);
    showToast('Key transfer failed', 'error');
  }
}

async function receiveKeyBundle(myPrivateKey: CryptoKey, remoteEphPubB64: string, encryptedBundleB64: string) {
  try {
    // Import remote ephemeral public key
    const remotePubBytes = Uint8Array.from(atob(remoteEphPubB64), (c) => c.charCodeAt(0));
    const remotePubKey = await crypto.subtle.importKey('raw', remotePubBytes, { name: 'X25519' } as any, false, []);

    // ECDH → shared secret → HKDF → AES key
    const sharedBits = await crypto.subtle.deriveBits(
      { name: 'X25519', public: remotePubKey } as any,
      myPrivateKey,
      256,
    );
    const aesKey = await crypto.subtle.importKey('raw', sharedBits, 'HKDF', false, ['deriveKey']);
    const decKey = await crypto.subtle.deriveKey(
      { name: 'HKDF', hash: 'SHA-256', salt: new Uint8Array(0), info: new TextEncoder().encode('rocchat-key-transfer') },
      aesKey,
      { name: 'AES-GCM', length: 256 },
      false,
      ['decrypt'],
    );

    // Decrypt
    const combined = Uint8Array.from(atob(encryptedBundleB64), (c) => c.charCodeAt(0));
    const iv = combined.slice(0, 12);
    const ct = combined.slice(12);
    const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, decKey, ct);
    const keyBundle = JSON.parse(new TextDecoder().decode(pt));

    // Store received keys
    const { putSecretString } = await import('../crypto/secure-store.js');
    if (keyBundle.identityPriv) await putSecretString('rocchat_identity_priv', keyBundle.identityPriv);
    if (keyBundle.identityPub) localStorage.setItem('rocchat_identity_pub', keyBundle.identityPub);
    if (keyBundle.encryptedKeys) await putSecretString('rocchat_keys', keyBundle.encryptedKeys);

    showToast('Keys received! Encryption ready.');
  } catch (err) {
    console.error('Key bundle decryption failed:', err);
    showToast('Failed to decrypt key bundle', 'error');
  }
}
