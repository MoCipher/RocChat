/**
 * RocChat Web — Sidebar Component
 *
 * Left nav rail: Roc bird logo + 3 tabs (Chats, Calls, Settings).
 * Per spec section 9.3: "Radically Simple UI — 3 Tabs"
 */

import { parseHTML } from '../utils.js';

export type Tab = 'chats' | 'calls' | 'channels' | 'settings';

const SIDEBAR_BIRD = `<svg viewBox="0 0 512 512" width="32" height="32">
  <defs>
    <linearGradient id="sb-bg" x1="0%" y1="0%" x2="100%" y2="100%">
      <stop offset="0%" stop-color="#0D1117"/><stop offset="40%" stop-color="#161B22"/><stop offset="100%" stop-color="#0D1117"/>
    </linearGradient>
    <radialGradient id="sb-glow" cx="50%" cy="40%" r="55%">
      <stop offset="0%" stop-color="#D4AF37" stop-opacity="0.25"/><stop offset="100%" stop-color="transparent"/>
    </radialGradient>
    <linearGradient id="sb-body" x1="30%" y1="0%" x2="70%" y2="100%">
      <stop offset="0%" stop-color="#fef3c7"/><stop offset="40%" stop-color="#f59e0b"/><stop offset="100%" stop-color="#b45309"/>
    </linearGradient>
    <linearGradient id="sb-wL" x1="100%" y1="30%" x2="0%" y2="80%">
      <stop offset="0%" stop-color="#fbbf24"/><stop offset="35%" stop-color="#d97706"/><stop offset="70%" stop-color="#92400e"/><stop offset="100%" stop-color="#451a03"/>
    </linearGradient>
    <linearGradient id="sb-wR" x1="0%" y1="30%" x2="100%" y2="80%">
      <stop offset="0%" stop-color="#fbbf24"/><stop offset="35%" stop-color="#d97706"/><stop offset="70%" stop-color="#92400e"/><stop offset="100%" stop-color="#451a03"/>
    </linearGradient>
    <linearGradient id="sb-head" x1="30%" y1="0%" x2="70%" y2="100%">
      <stop offset="0%" stop-color="#fffbeb"/><stop offset="100%" stop-color="#fbbf24"/>
    </linearGradient>
  </defs>
  <rect width="512" height="512" rx="112" fill="url(#sb-bg)"/>
  <rect width="512" height="512" rx="112" fill="url(#sb-glow)"/>
  <g transform="translate(256,250)">
    <path d="M-18,-15 C-50,-55 -95,-100 -155,-130 C-168,-135 -185,-132 -195,-125 C-180,-110 -160,-95 -140,-80 C-160,-90 -182,-95 -200,-92 C-185,-75 -165,-60 -140,-48 C-158,-55 -175,-55 -192,-50 C-170,-35 -148,-22 -120,-15 C-138,-18 -155,-18 -168,-12 C-145,-2 -118,5 -85,8 C-55,10 -30,2 -15,-5 Z" fill="url(#sb-wL)"/>
    <path d="M18,-15 C50,-55 95,-100 155,-130 C168,-135 185,-132 195,-125 C180,-110 160,-95 140,-80 C160,-90 182,-95 200,-92 C185,-75 165,-60 140,-48 C158,-55 175,-55 192,-50 C170,-35 148,-22 120,-15 C138,-18 155,-18 168,-12 C145,-2 118,5 85,8 C55,10 30,2 15,-5 Z" fill="url(#sb-wR)"/>
    <ellipse cx="0" cy="18" rx="26" ry="52" fill="url(#sb-body)"/>
    <ellipse cx="0" cy="5" rx="16" ry="28" fill="#fef3c7" opacity="0.4"/>
    <ellipse cx="0" cy="-42" rx="19" ry="21" fill="url(#sb-head)"/>
    <path d="M-3,-62 C-6,-78 -2,-88 0,-92 C2,-88 6,-78 3,-62" fill="#d97706" opacity="0.8"/>
    <ellipse cx="-7" cy="-44" rx="4" ry="4.5" fill="#fffbeb"/>
    <ellipse cx="7" cy="-44" rx="4" ry="4.5" fill="#fffbeb"/>
    <ellipse cx="-7" cy="-44" rx="2.5" ry="3" fill="#78350f"/>
    <ellipse cx="7" cy="-44" rx="2.5" ry="3" fill="#78350f"/>
    <circle cx="-6.5" cy="-45" r="1" fill="white" opacity="0.8"/>
    <circle cx="7.5" cy="-45" r="1" fill="white" opacity="0.8"/>
    <path d="M0,-36 L-4,-28 C-2,-24 2,-24 4,-28 L0,-36 Z" fill="#92400e"/>
  </g>
</svg>`;

export function renderSidebar(
  container: HTMLElement,
  activeTab: Tab,
  onTabChange: (tab: Tab) => void,
  unreadCount: number,
) {
  // Build profile button content: avatar image or fallback user icon
  const avatarUrl = localStorage.getItem('rocchat_avatar_url') || '';
  const uid = localStorage.getItem('rocchat_user_id') || '';
  const displayName = localStorage.getItem('rocchat_display_name') || '';
  const initials = displayName.split(' ').map(w => w[0]).join('').slice(0, 2).toUpperCase() || '?';
  let profileContent: string;
  if (avatarUrl && uid) {
    const path = avatarUrl.startsWith('/api/') ? avatarUrl : `/api${avatarUrl}`;
    const sep = path.includes('?') ? '&' : '?';
    profileContent = `<img class="sidebar-avatar" src="${path}${sep}uid=${encodeURIComponent(uid)}" alt="" loading="lazy" decoding="async" data-fallback-show-next="true"><span class="sidebar-avatar-fallback" style="display:none">${initials}</span>`;
  } else {
    profileContent = `<span class="sidebar-avatar-fallback">${initials}</span>`;
  }
  container.replaceChildren(parseHTML(`
    <nav class="sidebar" role="navigation" aria-label="Main navigation">
      <div class="sidebar-logo" title="RocChat">
        ${SIDEBAR_BIRD}
      </div>

      <button class="sidebar-btn ${activeTab === 'chats' ? 'active' : ''}" data-tab="chats"
              title="Chats" aria-label="Chats" role="tab" aria-selected="${activeTab === 'chats'}">
        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M7.9 20A9 9 0 1 0 4 16.1L2 22Z"/></svg>
        <span class="sidebar-btn-label">Chats</span>
        ${unreadCount > 0 ? `<span class="badge">${unreadCount}</span>` : ''}
      </button>

      <button class="sidebar-btn ${activeTab === 'calls' ? 'active' : ''}" data-tab="calls"
              title="Calls" aria-label="Calls" role="tab" aria-selected="${activeTab === 'calls'}">
        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6 19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72 12.84 12.84 0 0 0 .7 2.81 2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45 12.84 12.84 0 0 0 2.81.7A2 2 0 0 1 22 16.92z"/></svg>
        <span class="sidebar-btn-label">Calls</span>
      </button>

      <button class="sidebar-btn ${activeTab === 'channels' ? 'active' : ''}" data-tab="channels"
              title="Channels" aria-label="Channels" role="tab" aria-selected="${activeTab === 'channels'}">
        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M2 3h6a4 4 0 0 1 4 4v14a3 3 0 0 0-3-3H2z"/><path d="M22 3h-6a4 4 0 0 0-4 4v14a3 3 0 0 1 3-3h7z"/></svg>
        <span class="sidebar-btn-label">Channels</span>
      </button>

      <div class="sidebar-spacer"></div>

      <button class="sidebar-btn sidebar-profile-btn ${activeTab === 'settings' ? 'active' : ''}" data-tab="settings"
              title="Profile" aria-label="Profile" role="tab" aria-selected="${activeTab === 'settings'}">
        ${profileContent}
        <span class="sidebar-btn-label">Settings</span>
      </button>
    </nav>
  `));

  // Bind tab clicks
  container.querySelectorAll('.sidebar-btn[data-tab]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const tab = (btn as HTMLElement).dataset.tab as Tab;
      onTabChange(tab);
    });
  });

  // Render Lucide icons
  if (typeof (window as any).lucide !== 'undefined') {
    (window as any).lucide.createIcons();
  }
}
