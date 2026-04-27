/**
 * RocChat Web — Chat UI
 *
 * Conversation list + message view + composer.
 */

import * as api from '../api.js';
import type { Conversation, Message } from '../api.js';
import { escapeHtml, parseHTML, haptic } from '../utils.js';
import { showToast } from '../components/toast.js';
import { encryptMessage, decryptMessage, getOrCreateSession } from '../crypto/session-manager.js';
import { groupEncrypt, groupDecrypt, isGroupEncrypted, handleSenderKeyDistribution } from '../crypto/group-session-manager.js';
import { maybeRotateSignedPreKey } from '../crypto/client-crypto.js';
import { encryptProfileField, encryptGroupMeta, decryptGroupMeta, decryptProfileField } from '../crypto/profile-crypto.js';
import type { EncryptedMessage } from '@rocchat/shared';
import { generateSafetyNumber, fromBase64, toBase64, randomBytes, sha256 as cryptoSha256 } from '@rocchat/shared';
import { initEmojiPicker } from './emoji-picker.js';
import { initGifPicker } from './gif-picker.js';
import { attachPreviewIfAny } from './link-preview.js';
import { getSecretString, putSecretString, deleteSecret } from '../crypto/secure-store.js';
import {
  consumeOneShotExpiry,
  openPerMessageTimerMenu,
  toggleVoiceTranscription,
  openForwardDialog,
  openGlobalSearch,
  openGroupAdminDialog,
  renderCustomEmoji,
} from '../features.js';

// ── Lightweight AES-GCM for metadata signals (typing, presence, read receipts) ──
// Uses a per-conversation key derived from HKDF(vaultKey, conversationId).
// Falls back to legacy identity-pub-based derivation for backward compat.
const metaKeyCache = new Map<string, CryptoKey>();

async function getMetaKey(conversationId: string): Promise<CryptoKey> {
  const cached = metaKeyCache.get(conversationId);
  if (cached) return cached;
  let key: CryptoKey;
  const { getSecretString } = await import('./crypto/secure-store.js');
  const vkB64 = await getSecretString('rocchat_vault_key');
  if (vkB64) {
    const vkBin = atob(vkB64);
    const vkBytes = new Uint8Array(vkBin.length);
    for (let i = 0; i < vkBin.length; i++) vkBytes[i] = vkBin.charCodeAt(i);
    const baseKey = await crypto.subtle.importKey('raw', vkBytes, 'HKDF', false, ['deriveKey']);
    key = await crypto.subtle.deriveKey(
      { name: 'HKDF', hash: 'SHA-256', salt: new Uint8Array(0), info: new TextEncoder().encode('rocchat:meta:' + conversationId) },
      baseKey,
      { name: 'AES-GCM', length: 256 },
      false,
      ['encrypt', 'decrypt'],
    );
  } else {
    const idKey = localStorage.getItem('rocchat_identity_pub') || conversationId;
    const raw = new TextEncoder().encode(idKey + ':meta:' + conversationId);
    const hash = await crypto.subtle.digest('SHA-256', raw);
    key = await crypto.subtle.importKey('raw', hash, 'AES-GCM', false, ['encrypt', 'decrypt']);
  }
  metaKeyCache.set(conversationId, key);
  return key;
}

async function encryptMeta(conversationId: string, data: Record<string, unknown>): Promise<string> {
  const key = await getMetaKey(conversationId);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const plain = new TextEncoder().encode(JSON.stringify(data));
  const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, plain);
  return toBase64(iv) + '.' + toBase64(new Uint8Array(ct));
}

async function decryptMeta(conversationId: string, payload: string): Promise<Record<string, unknown>> {
  const key = await getMetaKey(conversationId);
  const [ivB64, ctB64] = payload.split('.');
  const iv = new Uint8Array(fromBase64(ivB64));
  const ct = new Uint8Array(fromBase64(ctB64));
  const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, ct);
  return JSON.parse(new TextDecoder().decode(plain));
}

interface ChatState {
  conversations: Conversation[];
  activeConversationId: string | null;
  messages: Map<string, Message[]>;
  ws: WebSocket | null;
}

// Decrypt encrypted_meta on conversations to populate readable names
async function decryptConversationMeta(convs: Conversation[]): Promise<void> {
  for (const c of convs) {
    if (c.encrypted_meta && c.encrypted_meta.includes('.')) {
      try {
        const meta = await decryptGroupMeta(c.id, c.encrypted_meta);
        if (meta.name) c.name = meta.name;
      } catch { /* leave name as-is */ }
    }
  }
}

// Local encrypted plaintext cache keyed by server message id.
// Prevents "Unable to decrypt" on the sender's own messages after reload,
// and caches successful receiver decrypts so reloads stay instant.
const PLAINTEXT_CACHE_KEY = 'rocchat_plaintext_v1';
const plaintextCache = new Map<string, string>();
let plaintextCacheHydratePromise: Promise<void> | null = null;
let plaintextCacheSaveTimer: ReturnType<typeof setTimeout> | null = null;

async function hydratePlaintextCache(): Promise<void> {
  if (plaintextCacheHydratePromise) return plaintextCacheHydratePromise;
  plaintextCacheHydratePromise = (async () => {
    try {
      const secureRaw = await getSecretString(PLAINTEXT_CACHE_KEY);
      const legacyRaw = localStorage.getItem(PLAINTEXT_CACHE_KEY);
      const raw = secureRaw ?? legacyRaw;
      if (raw) {
        const obj = JSON.parse(raw) as Record<string, string>;
        plaintextCache.clear();
        for (const [key, value] of Object.entries(obj)) plaintextCache.set(key, value);
      }
      if (legacyRaw) {
        await putSecretString(PLAINTEXT_CACHE_KEY, JSON.stringify(Object.fromEntries(plaintextCache)));
        localStorage.removeItem(PLAINTEXT_CACHE_KEY);
      }
    } catch {
      plaintextCache.clear();
    }
  })();
  return plaintextCacheHydratePromise;
}

function savePlaintextCache() {
  if (plaintextCacheSaveTimer) return;
  plaintextCacheSaveTimer = setTimeout(() => {
    plaintextCacheSaveTimer = null;
    void (async () => {
      // Cap to last ~5000 entries to avoid unbounded growth.
      const entries = [...plaintextCache.entries()];
      const capped = entries.slice(-5000);
      plaintextCache.clear();
      for (const [k, v] of capped) plaintextCache.set(k, v);
      try {
        await putSecretString(PLAINTEXT_CACHE_KEY, JSON.stringify(Object.fromEntries(plaintextCache)));
        localStorage.removeItem(PLAINTEXT_CACHE_KEY);
      } catch {}
    })();
  }, 300);
}

export function getPlaintextCacheSnapshot(): Record<string, string> {
  return Object.fromEntries(plaintextCache);
}

// Per-conversation "last decrypted message" for sidebar preview text.
// Keys: conversationId → { ts: epoch-ms, preview: display string }
const lastConvPreview = new Map<string, { ts: number; preview: string }>();

function buildConvPreview(plaintext: string): string {
  try {
    const obj = JSON.parse(plaintext);
    if (obj && (obj.blobId || obj.blob_id || obj.mediaId || obj.media_id) && (obj.filename || obj.file_name)) {
      const mime: string = obj.mime || '';
      if (mime.startsWith('image/')) return '📷 Photo';
      if (mime.startsWith('video/')) return '🎥 Video';
      if (mime.startsWith('audio/')) return obj.type === 'voice_note' ? '🎤 Voice message' : '🎵 Audio';
      return `📎 ${obj.filename}`;
    }
    if (obj && obj.type === 'gif') return '🎞 GIF';
    if (obj && obj.type === 'vault_item') return '🔑 Vault item';
  } catch { /* not JSON */ }
  // Plain text — truncate
  return plaintext.length > 80 ? plaintext.slice(0, 80) + '…' : plaintext;
}

function updateConvPreview(conversationId: string, plaintext: string, msgCreatedAt: string) {
  const ts = msgCreatedAt ? Date.parse(msgCreatedAt) : Date.now();
  const existing = lastConvPreview.get(conversationId);
  if (existing && existing.ts > ts) return; // don't overwrite with older messages
  lastConvPreview.set(conversationId, { ts, preview: buildConvPreview(plaintext) });
}

function previewFromMessageType(messageType?: string): string {
  switch (messageType) {
    case 'image': return '📷 Photo';
    case 'video':
    case 'video_note': return '🎥 Video';
    case 'voice_note': return '🎤 Voice message';
    case 'file': return '📎 File';
    case 'call_offer':
    case 'call_answer':
    case 'call_end': return '📞 Call activity';
    default: return 'Encrypted message';
  }
}

function cachePlaintext(messageId: string, plaintext: string, conversationId?: string, createdAt?: string) {
  if (!messageId || messageId.startsWith('queued-')) return;
  plaintextCache.set(messageId, plaintext);
  if (conversationId && createdAt) updateConvPreview(conversationId, plaintext, createdAt);
  savePlaintextCache();
}

interface QueuedMessage {
  payload: Parameters<typeof api.sendMessage>[0];
  localId: string;
  conversationId: string;
}

const state: ChatState = {
  conversations: [],
  activeConversationId: null,
  messages: new Map(),
  ws: null,
};

// ── Delivery status tracking ──
// 'queued' → 'sent' → 'delivered' → 'read'
type DeliveryStatus = 'queued' | 'syncing' | 'sent' | 'delivered' | 'read';
const deliveryStatus = new Map<string, DeliveryStatus>();
const onlineUsers = new Set<string>();

// ── Folder filter state ──
let activeFolderId: string | null = null;

function getStatusIcon(msgId: string, isMine: boolean): string {
  if (!isMine) return '';
  const status = deliveryStatus.get(msgId) || 'delivered';
  switch (status) {
    case 'queued': return '<span class="message-status" title="Queued">🕐</span>';
    case 'syncing': return '<span class="message-status" title="Syncing">⟳</span>';
    case 'sent': return '<span class="message-status" title="Sent">✓</span>';
    case 'delivered': return '<span class="message-status" title="Delivered">✓✓</span>';
    case 'read': return '<span class="message-status message-status-read" title="Read">✓✓</span>';
    default: return '<span class="message-status">✓✓</span>';
  }
}

// ── Offline message queue (persisted in IndexedDB) ──
const messageQueue: QueuedMessage[] = [];

/** WebSocket reconnect attempts per conversation (for exponential backoff). */
const wsReconnectAttempts = new Map<string, number>();

const MQ_DB_NAME = 'rocchat_mq';
const MQ_STORE = 'queue';

function notifyQueueUpdated(): void {
  window.dispatchEvent(new CustomEvent('rocchat:queue-updated'));
}

function openMqDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(MQ_DB_NAME, 1);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(MQ_STORE)) {
        db.createObjectStore(MQ_STORE, { keyPath: 'localId' });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function loadMessageQueue(): Promise<void> {
  try {
    const db = await openMqDb();
    const tx = db.transaction(MQ_STORE, 'readonly');
    const req = tx.objectStore(MQ_STORE).getAll();
    await new Promise<void>((resolve, reject) => {
      req.onsuccess = () => {
        messageQueue.length = 0;
        for (const item of req.result as Array<Partial<QueuedMessage>>) {
          if (!item.payload || !item.localId || !item.conversationId) continue;
          // Strip any legacy persisted auth token fields from older builds.
          messageQueue.push({
            payload: item.payload,
            localId: item.localId,
            conversationId: item.conversationId,
          });
        }
        notifyQueueUpdated();
        resolve();
      };
      req.onerror = () => reject(req.error);
    });
  } catch { /* proceed with empty queue */ }
}

async function persistQueueItem(item: QueuedMessage): Promise<void> {
  try {
    const db = await openMqDb();
    const tx = db.transaction(MQ_STORE, 'readwrite');
    tx.objectStore(MQ_STORE).put(item);
    notifyQueueUpdated();
  } catch { /* best effort */ }
}

async function removeQueueItem(localId: string): Promise<void> {
  try {
    const db = await openMqDb();
    const tx = db.transaction(MQ_STORE, 'readwrite');
    tx.objectStore(MQ_STORE).delete(localId);
    notifyQueueUpdated();
  } catch { /* best effort */ }
}

// Load persisted queue on module init
loadMessageQueue();

async function flushMessageQueue() {
  const pending = [...messageQueue];
  for (const item of pending) {
    try {
      await api.sendMessage(item.payload);
      // Remove from queue on success
      const idx = messageQueue.indexOf(item);
      if (idx !== -1) messageQueue.splice(idx, 1);
      notifyQueueUpdated();
      await removeQueueItem(item.localId);
      // Update local message status
      const msgs = state.messages.get(item.conversationId);
      const local = msgs?.find((m) => m.id === item.localId);
      if (local) local.id = local.id.replace('queued-', 'sent-');
      if (msgs && state.activeConversationId === item.conversationId) renderMessages(msgs);
    } catch {
      break; // Stop retrying if still offline
    }
  }
}

// Flush queue when coming back online
let flushInProgress = false;
window.addEventListener('online', () => {
  if (!flushInProgress && messageQueue.length > 0) {
    flushInProgress = true;
    flushMessageQueue().finally(() => { flushInProgress = false; });
  }
  showToast('Back online', 'success');
  const banner = document.getElementById('offline-banner');
  if (banner) {
    banner.classList.remove('visible');
    banner.setAttribute('aria-hidden', 'true');
  }
});

window.addEventListener('offline', () => {
  showToast('You are offline — messages will be queued', 'error');
  const banner = document.getElementById('offline-banner');
  if (banner) {
    banner.classList.add('visible');
    banner.setAttribute('aria-hidden', 'false');
  }
});

// Warn before navigating away with messages still in the send queue.
window.addEventListener('beforeunload', (e) => {
  if (messageQueue.length > 0) {
    e.preventDefault();
    e.returnValue = 'You have unsent messages. Leave anyway?';
  }
});

export async function renderChats(container: HTMLElement) {
  await hydratePlaintextCache();
  container.replaceChildren(parseHTML(`
    <div class="panel-list" id="conversations-panel">
      <div class="panel-header">
        <div class="panel-header-top">
          <h2>Chats</h2>
          <button class="icon-btn" id="global-search-btn" title="Search" aria-label="Search">
            <i data-lucide="search" style="width:18px;height:18px"></i>
          </button>
          <button class="icon-btn" id="new-chat-btn" title="New conversation" aria-label="New conversation">
            <i data-lucide="edit" style="width:18px;height:18px"></i>
          </button>
        </div>
        <div class="search-box">
          <i data-lucide="search" style="width:16px;height:16px;color:var(--text-tertiary)"></i>
          <input type="text" placeholder="Search..." id="chat-search" />
        </div>
        <div class="folder-tabs" id="folder-tabs"></div>
      </div>
      <div class="conversations-list" id="conversations-list" aria-busy="true">
        ${Array.from({ length: 5 }).map(() => `
          <div class="conversation-skeleton" aria-hidden="true">
            <div class="skel-avatar"></div>
            <div class="skel-lines">
              <div class="skel-line skel-line-title"></div>
              <div class="skel-line skel-line-sub"></div>
            </div>
          </div>
        `).join('')}
      </div>
    </div>
    <div class="chat-view" id="chat-view">
      <div class="empty-state">
        <div class="empty-state-icon">
          <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="var(--roc-gold)" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" opacity="0.4">
            <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/>
          </svg>
        </div>
        <h3>Select a conversation</h3>
        <p>Choose from your chats or start a new one.</p>
        <p style="font-family:var(--font-mono);font-size:var(--text-xs);color:var(--turquoise);margin-top:var(--sp-2)">
          🔒 End-to-end encrypted
        </p>
      </div>
    </div>
  `));

  // Load conversations + folders in parallel
  try {
    const [convRes, folderRes] = await Promise.all([api.getConversations(), api.getChatFolders()]);
    if (convRes.ok) {
      state.conversations = convRes.data.conversations || [];
      await decryptConversationMeta(state.conversations);
    }
    if (folderRes.ok) {
      renderFolderTabs(folderRes.data as unknown as api.ChatFolder[]);
    }
    renderConversationsList();
  } catch {
    // Network error — show empty
  }

  // Rotate signed pre-key if needed (non-blocking)
  maybeRotateSignedPreKey().catch(e => console.warn('SPK rotation failed:', e));

  // Bind new chat
  container.querySelector('#new-chat-btn')?.addEventListener('click', () => {
    showNewChatDialog(container);
  });

  // Global search button
  container.querySelector('#global-search-btn')?.addEventListener('click', () => openGlobalSearch());

  // Search filter (debounced)
  let searchTimeout: ReturnType<typeof setTimeout>;
  container.querySelector('#chat-search')?.addEventListener('input', (e) => {
    clearTimeout(searchTimeout);
    const q = (e.target as HTMLInputElement).value.toLowerCase();
    searchTimeout = setTimeout(() => renderConversationsList(q), 200);
  });

  // Pull-to-refresh on conversations list
  attachPullToRefresh(container.querySelector('#conversations-list') as HTMLElement | null);

  if (typeof (window as any).lucide !== 'undefined') {
    (window as any).lucide.createIcons();
  }
}

function attachPullToRefresh(el: HTMLElement | null) {
  if (!el) return;
  let startY = 0;
  let pulling = false;
  let refreshing = false;
  const threshold = 64;
  const indicator = document.createElement('div');
  indicator.style.cssText = 'position:absolute;top:-40px;left:50%;transform:translateX(-50%);width:28px;height:28px;border:2px solid var(--roc-gold);border-top-color:transparent;border-radius:50%;transition:transform .15s;pointer-events:none;opacity:0;';
  el.style.position = 'relative';
  el.prepend(indicator);
  el.addEventListener('touchstart', (e) => {
    if (refreshing) return;
    if (el.scrollTop > 0) return;
    startY = e.touches[0].clientY;
    pulling = true;
  }, { passive: true });
  el.addEventListener('touchmove', (e) => {
    if (!pulling || refreshing) return;
    const dy = e.touches[0].clientY - startY;
    if (dy <= 0) { indicator.style.opacity = '0'; return; }
    const pct = Math.min(1, dy / threshold);
    indicator.style.opacity = String(pct);
    indicator.style.transform = `translateX(-50%) translateY(${Math.min(dy, threshold + 20)}px) rotate(${dy * 4}deg)`;
  }, { passive: true });
  el.addEventListener('touchend', async (e) => {
    if (!pulling) return;
    pulling = false;
    const dy = (e.changedTouches[0]?.clientY ?? 0) - startY;
    if (dy > threshold && !refreshing) {
      refreshing = true;
      haptic([10, 30, 10]);
      indicator.style.animation = 'rocchat-spin 0.8s linear infinite';
      try {
        const res = await api.getConversations();
        if (res.ok) {
          state.conversations = res.data.conversations || [];
          await decryptConversationMeta(state.conversations);
          renderConversationsList();
        }
      } catch {}
      refreshing = false;
      indicator.style.animation = '';
      indicator.style.opacity = '0';
      indicator.style.transform = 'translateX(-50%)';
    } else {
      indicator.style.opacity = '0';
      indicator.style.transform = 'translateX(-50%)';
    }
  });
  // Spin keyframes (inject once)
  if (!document.getElementById('rocchat-pull-kf')) {
    const style = document.createElement('style');
    style.id = 'rocchat-pull-kf';
    style.textContent = '@keyframes rocchat-spin { to { transform: translateX(-50%) translateY(40px) rotate(360deg); } }';
    document.head.appendChild(style);
  }
}

function renderFolderTabs(folders: api.ChatFolder[]) {
  const tabsEl = document.getElementById('folder-tabs');
  if (!tabsEl) return;
  if (!folders.length) { tabsEl.style.display = 'none'; return; }

  tabsEl.style.display = 'flex';
  tabsEl.setAttribute('role', 'tablist');
  tabsEl.setAttribute('aria-label', 'Chat folders');
  tabsEl.replaceChildren(parseHTML(`
    <button class="folder-tab ${activeFolderId === null ? 'active' : ''}" role="tab" aria-selected="${activeFolderId === null ? 'true' : 'false'}" data-folder-id="">All</button>
    ${folders.map(f => `<button class="folder-tab ${activeFolderId === f.id ? 'active' : ''}" role="tab" aria-selected="${activeFolderId === f.id ? 'true' : 'false'}" data-folder-id="${f.id}" data-conv-ids="${f.conversation_ids.join(',')}">${escapeHtml(f.icon)} ${escapeHtml(f.name)}</button>`).join('')}
  `));
  tabsEl.querySelectorAll('.folder-tab').forEach(btn => {
    btn.addEventListener('click', () => {
      const fid = (btn as HTMLElement).dataset.folderId || null;
      activeFolderId = fid || null;
      tabsEl.querySelectorAll('.folder-tab').forEach(b => {
        b.classList.remove('active');
        b.setAttribute('aria-selected', 'false');
      });
      btn.classList.add('active');
      btn.setAttribute('aria-selected', 'true');
      renderConversationsList();
    });
  });
}

function renderConversationsList(filter = '') {
  const list = document.getElementById('conversations-list');
  if (!list) return;
  list.removeAttribute('aria-busy');

  const userId = localStorage.getItem('rocchat_user_id') || '';
  let filtered = state.conversations;

  // Apply folder filter
  if (activeFolderId) {
    const tabsEl = document.getElementById('folder-tabs');
    const activeTab = tabsEl?.querySelector(`.folder-tab[data-folder-id="${activeFolderId}"]`);
    // We need the folder's conversation_ids — stored on the tab as data
    const folderConvIds = (activeTab as HTMLElement)?.dataset.convIds?.split(',') || [];
    if (folderConvIds.length) {
      filtered = filtered.filter(c => folderConvIds.includes(c.id));
    }
  }

  if (filter) {
    filtered = filtered.filter((c) => {
      const name = getConversationName(c, userId).toLowerCase();
      return name.includes(filter);
    });
  }

  if (filtered.length === 0) {
    list.replaceChildren(parseHTML(`
      <div class="empty-state" style="padding:var(--sp-8);text-align:center">
        <div style="font-size:48px;margin-bottom:var(--sp-4);opacity:0.4">${filter ? '🔍' : '💬'}</div>
        <p style="font-size:var(--text-sm);color:var(--text-secondary);margin-bottom:var(--sp-2)">
          ${filter ? 'No matching conversations' : 'No conversations yet'}
        </p>
        ${!filter ? '<p style="font-size:var(--text-xs);color:var(--text-tertiary)">Tap the <strong>✏️</strong> button above to start a new chat</p>' : ''}
      </div>
    `));
    return;
  }

  list.replaceChildren(parseHTML(filtered
    .map((c) => {
      const name = getConversationName(c, userId);
      const other = c.members.find(m => m.user_id !== userId);
      const time = c.last_message_at ? formatTime(c.last_message_at) : '';
      const isActive = c.id === state.activeConversationId;
      const preview = lastConvPreview.get(c.id)?.preview || previewFromMessageType(c.last_message_type);

      return `
        <div class="swipe-container" data-conv-id="${c.id}">
          <div class="swipe-actions-right">
            <button class="swipe-action swipe-pin" title="${c.pinned ? 'Unpin' : 'Pin'}" aria-label="${c.pinned ? 'Unpin conversation' : 'Pin conversation'}">📌</button>
            <button class="swipe-action swipe-mute" title="Mute" aria-label="Mute conversation"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M18.8 5.2a1 1 0 0 0-1.4 0l-12 12a1 1 0 1 0 1.4 1.4l12-12a1 1 0 0 0 0-1.4z"/><path d="M2 1 1 2"/><path d="m7 7-3.8 3.8a2 2 0 0 0 0 2.8L8 18.4a2 2 0 0 0 2.8 0L14.7 14.7"/><path d="m10 10 4-4a2 2 0 0 1 2.8 0l2.4 2.4a2 2 0 0 1 0 2.8L15.3 15.3"/></svg></button>
            <button class="swipe-action swipe-archive" title="Archive" aria-label="Archive conversation"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect width="20" height="5" x="2" y="3" rx="1"/><path d="M4 8v11a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8"/><path d="M10 12h4"/></svg></button>
            <button class="swipe-action swipe-delete" title="Delete" aria-label="Delete conversation"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h18"/><path d="M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6"/><path d="M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2"/></svg></button>
          </div>
          <div class="conversation-item swipeable ${isActive ? 'active' : ''}" data-id="${c.id}" role="button" tabindex="0" aria-label="Chat with ${escapeHtml(name)}" ${isActive ? 'aria-current="true"' : ''}>
            ${renderAvatar(name, other?.avatar_url, other?.user_id, 50, 18, other?.account_tier)}
            <div class="conversation-info">
              <div class="conversation-name">${escapeHtml(name)}</div>
              <div class="conversation-preview" title="${escapeHtml(preview)}">
                <span style="font-size:10px;margin-right:2px">🔒</span> ${escapeHtml(preview)}
              </div>
            </div>
            <div class="conversation-meta">
              <span class="conversation-time">${time}</span>
              ${c.pinned ? '<span style="font-size:10px;color:var(--accent)" title="Pinned">📌</span>' : ''}
              ${c.muted ? '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="var(--text-muted)" stroke-width="2" style="margin-top:2px"><line x1="1" y1="1" x2="23" y2="23"/><path d="M9 9v3a3 3 0 0 0 5.12 2.12M15 9.34V4a3 3 0 0 0-5.94-.6"/><path d="M17 16.95A7 7 0 0 1 5 12v-2m14 0v2c0 .76-.13 1.49-.35 2.17"/><line x1="12" y1="19" x2="12" y2="23"/><line x1="8" y1="23" x2="16" y2="23"/></svg>' : ''}
            </div>
          </div>
        </div>
      `;
    })
    .join('')));

  // Bind clicks
  list.querySelectorAll('.conversation-item').forEach((el) => {
    el.addEventListener('click', () => {
      const id = (el as HTMLElement).dataset.id!;
      openConversation(id);
    });
    el.addEventListener('keydown', (e) => {
      if ((e as KeyboardEvent).key === 'Enter' || (e as KeyboardEvent).key === ' ') {
        e.preventDefault();
        const id = (el as HTMLElement).dataset.id!;
        openConversation(id);
      }
    });
  });

  // Bind swipe gestures
  initSwipeActions(list);

  // Update PWA app badge with total unread count
  updateAppBadge();
}

/** Update PWA badge count (home screen icon) with total unread conversations. */
function updateAppBadge(): void {
  try {
    const nav = navigator as Navigator & { setAppBadge?: (n: number) => Promise<void>; clearAppBadge?: () => Promise<void> };
    if (!nav.setAppBadge) return;
    // Count conversations with unread messages (those not currently open)
    const userId = localStorage.getItem('rocchat_user_id') || '';
    const unread = state.conversations.filter(c =>
      c.id !== state.activeConversationId &&
      c.last_message_at &&
      c.members.some(m => m.user_id !== userId)
    ).length;
    if (unread > 0) {
      nav.setAppBadge(unread).catch(() => {});
    } else {
      nav.clearAppBadge?.().catch(() => {});
    }
  } catch { /* Badge API unavailable */ }
}

async function openConversation(conversationId: string) {
  state.activeConversationId = conversationId;
  renderConversationsList(); // Update active state

  const conv = state.conversations.find((c) => c.id === conversationId);
  if (!conv) return;

  // Apply per-conversation theme
  applyConversationTheme(conv.chat_theme || null);

  const userId = localStorage.getItem('rocchat_user_id') || '';
  const name = getConversationName(conv, userId);
  const other = getOtherMember(conv);

  const chatView = document.getElementById('chat-view');
  if (!chatView) return;

  chatView.replaceChildren(parseHTML(`
    <div class="chat-header">
      <button class="mobile-back-btn" id="btn-back" aria-label="Back to conversations">
        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M15 18l-6-6 6-6"/></svg>
      </button>
      ${renderAvatar(name, other?.avatar_url, other?.user_id, 36, 13, other?.account_tier)}
      <div class="chat-header-info">
        <div class="chat-header-name">${escapeHtml(name)}<span id="safety-badge" style="margin-left:4px;font-size:12px;display:none" title="Identity verified">✅</span></div>
        <div class="chat-header-status">
          <span style="font-size:8px">🔒</span> End-to-end encrypted
        </div>
      </div>
      <div class="chat-header-actions">
        <button class="icon-btn" title="Search messages" id="btn-search-messages" aria-label="Search messages">
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="11" r="8"/><path d="m21 21-4.3-4.3"/></svg>
        </button>
        <button class="icon-btn" title="Verify safety number" id="btn-verify" aria-label="Verify safety number">
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20 13c0 5-3.5 7.5-7.66 8.95a1 1 0 0 1-.67-.01C7.5 20.5 4 18 4 13V6a1 1 0 0 1 1-1c2 0 4.5-1.2 6.24-2.72a1.17 1.17 0 0 1 1.52 0C14.51 3.81 17 5 19 5a1 1 0 0 1 1 1z"/><path d="m9 12 2 2 4-4"/></svg>
        </button>
        <button class="icon-btn" title="Disappearing messages" id="btn-disappear" aria-label="Disappearing messages">
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>
        </button>
        <button class="icon-btn" title="Notifications" id="btn-notif-mode" aria-label="Notifications for this conversation">
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9"/><path d="M10.3 21a1.94 1.94 0 0 0 3.4 0"/></svg>
        </button>
        <button class="icon-btn" title="Chat theme" id="btn-chat-theme" aria-label="Chat theme">
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="13.5" cy="6.5" r="0.5" fill="currentColor"/><circle cx="17.5" cy="10.5" r="0.5" fill="currentColor"/><circle cx="8.5" cy="7.5" r="0.5" fill="currentColor"/><circle cx="6.5" cy="12" r="0.5" fill="currentColor"/><path d="M12 2C6.5 2 2 6.5 2 12s4.5 10 10 10c.926 0 1.648-.746 1.648-1.688 0-.437-.18-.835-.437-1.125-.29-.289-.438-.652-.438-1.125a1.64 1.64 0 0 1 1.668-1.668h1.996c3.051 0 5.555-2.503 5.555-5.554C21.965 6.012 17.461 2 12 2z"/></svg>
        </button>
        <button class="icon-btn" title="Pinned messages" id="btn-pinned" aria-label="Pinned messages">
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 17v5"/><path d="M9 10.76a2 2 0 0 1-1.11 1.79l-1.78.9A2 2 0 0 0 5 15.24V16a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1v-.76a2 2 0 0 0-1.11-1.79l-1.78-.9A2 2 0 0 1 15 10.76V7a1 1 0 0 1 1-1 2 2 0 0 0 0-4H8a2 2 0 0 0 0 4 1 1 0 0 1 1 1z"/></svg>
        </button>
        <button class="icon-btn" title="Voice call" id="btn-voice-call" aria-label="Voice call">
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6 19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72 12.84 12.84 0 0 0 .7 2.81 2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45 12.84 12.84 0 0 0 2.81.7A2 2 0 0 1 22 16.92z"/></svg>
        </button>
        <button class="icon-btn" title="Video call" id="btn-video-call" aria-label="Video call">
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m16 13 5.223 3.482a.5.5 0 0 0 .777-.416V7.87a.5.5 0 0 0-.752-.432L16 10.5"/><rect x="2" y="6" width="14" height="12" rx="2"/></svg>
        </button>
        <button class="icon-btn" title="Info" id="btn-chat-info" aria-label="Conversation info">
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><path d="M12 16v-4"/><path d="M12 8h.01"/></svg>
        </button>
        ${conv.type === 'group' ? `
        <button class="icon-btn" title="Manage members" id="btn-group-admin" aria-label="Manage members">
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M22 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/></svg>
        </button>` : ''}
      </div>
    </div>

    <div class="messages-area" id="messages-area" role="log" aria-label="Messages" aria-live="polite">
      <div class="encryption-banner">
        <span>🔒</span> Messages are end-to-end encrypted. No one outside this chat can read them.
      </div>
      <div class="skeleton skeleton-message" style="width:55%"></div>
      <div class="skeleton skeleton-message" style="width:40%"></div>
      <div class="skeleton skeleton-message" style="width:50%"></div>
    </div>

    <div class="composer">
      <button class="icon-btn" title="Attach file" aria-label="Attach file">
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m21.44 11.05-9.19 9.19a6 6 0 0 1-8.49-8.49l8.57-8.57A4 4 0 1 1 18 8.84l-8.59 8.57a2 2 0 0 1-2.83-2.83l8.49-8.48"/></svg>
      </button>
      <button class="icon-btn" id="vault-btn" title="Share vault item" aria-label="Share vault item">
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="11" width="18" height="11" rx="2" ry="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/></svg>
      </button>
      <button class="icon-btn" id="emoji-btn" title="Emoji" aria-label="Emoji" aria-expanded="false" aria-controls="emoji-picker">
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><path d="M8 14s1.5 2 4 2 4-2 4-2"/><line x1="9" x2="9.01" y1="9" y2="9"/><line x1="15" x2="15.01" y1="9" y2="9"/></svg>
      </button>
      <button class="icon-btn" id="voice-btn" title="Dictate (voice-to-text)" aria-label="Dictate">
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="2" width="6" height="12" rx="3"/><path d="M5 10v2a7 7 0 0 0 14 0v-2"/><line x1="12" x2="12" y1="19" y2="22"/></svg>
      </button>
      <button class="icon-btn" id="msg-timer-btn" title="Per-message timer" aria-label="Per-message timer">
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="13" r="8"/><path d="M12 9v4l2 2"/><path d="M9 2h6"/></svg>
      </button>
      <span id="one-shot-badge" style="display:none;font-size:11px;color:var(--gold,#d4af37);align-self:center;margin:0 4px"></span>
      <button class="icon-btn" id="gif-btn" title="GIF" aria-label="Send GIF" aria-expanded="false" aria-controls="gif-picker">
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="4" width="20" height="16" rx="2"/><text x="12" y="15" text-anchor="middle" font-size="8" font-weight="bold" fill="currentColor" stroke="none">GIF</text></svg>
      </button>
      <textarea class="composer-input" id="message-input" placeholder="Type a message..."
                rows="1" aria-label="Message"></textarea>
      <button class="icon-btn" id="schedule-btn" title="Schedule message" aria-label="Schedule message">
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><polyline points="12,6 12,12 16,14"/></svg>
      </button>
      <button class="icon-btn" id="voice-note-btn" title="Record voice note" aria-label="Record voice note">
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z"/><path d="M19 10v2a7 7 0 0 1-14 0v-2"/><line x1="12" x2="12" y1="19" y2="23"/><line x1="8" x2="16" y1="23" y2="23"/></svg>
      </button>
      <button class="icon-btn" id="video-note-btn" title="Record video message" aria-label="Record video message">
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m22 8-6 4 6 4V8Z"/><rect width="14" height="12" x="2" y="6" rx="2" ry="2"/></svg>
      </button>
      <button class="icon-btn" id="priority-btn" title="Set message priority" aria-label="Set priority">
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M13 2L3 14h9l-1 8 10-12h-9l1-8z"/></svg>
      </button>
      <button class="send-btn" id="send-btn" disabled title="Send" aria-label="Send message">
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m22 2-7 20-4-9-9-4Z"/><path d="M22 2 11 13"/></svg>
      </button>
    </div>
    <div id="composer-queue-status" style="display:none;padding:6px 14px;border-top:1px solid var(--border-weak);font-size:12px;color:var(--text-secondary)"></div>
    <div class="emoji-picker" id="emoji-picker" style="display:none"></div>
    <div class="gif-picker" id="gif-picker" style="display:none"></div>
  `));

  // Mobile responsive: mark layout as having open conversation
  document.querySelector('.app-layout')?.classList.add('has-conversation');

  // Bind back button for mobile
  chatView.querySelector('#btn-back')?.addEventListener('click', () => {
    state.activeConversationId = null;
    document.querySelector('.app-layout')?.classList.remove('has-conversation');
    renderConversationsList();
    const cv = document.getElementById('chat-view');
    if (cv) cv.replaceChildren(parseHTML(`
      <div class="empty-state">
        <div class="empty-state-icon">
          <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="var(--roc-gold)" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" opacity="0.4">
            <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/>
          </svg>
        </div>
        <h3>Select a conversation</h3>
        <p>Choose from your chats or start a new one.</p>
      </div>
    `));
  });

  // Load messages
  await loadMessages(conversationId);

  // Show safety badge if verified
  updateSafetyBadge(conv);

  // Connect WebSocket
  connectWebSocket(conversationId);

  // Bind composer
  const input = chatView.querySelector('#message-input') as HTMLTextAreaElement;
  const sendBtn = chatView.querySelector('#send-btn') as HTMLButtonElement;

  input?.addEventListener('input', () => {
    sendBtn.disabled = !input.value.trim();
    // Auto-resize
    input.style.height = 'auto';
    input.style.height = Math.min(input.scrollHeight, 120) + 'px';
    // Save draft to secure store (fire-and-forget)
    const v = input.value;
    void (v ? putSecretString(`rocchat_draft_${conversationId}`, v) : deleteSecret(`rocchat_draft_${conversationId}`));
  });

  // Restore draft — check secure store first, fall back to legacy localStorage and migrate
  const [secureDraft, legacyDraft] = await Promise.all([
    getSecretString(`rocchat_draft_${conversationId}`).catch(() => null),
    Promise.resolve(localStorage.getItem(`rocchat_draft_${conversationId}`)),
  ]);
  const savedDraft = secureDraft ?? legacyDraft;
  if (legacyDraft && !secureDraft) {
    void putSecretString(`rocchat_draft_${conversationId}`, legacyDraft);
    localStorage.removeItem(`rocchat_draft_${conversationId}`);
  }
  if (savedDraft && input) {
    input.value = savedDraft;
    sendBtn.disabled = false;
    input.style.height = 'auto';
    input.style.height = Math.min(input.scrollHeight, 120) + 'px';
  }

  input?.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      if (input.value.trim()) sendMessageHandler();
    }
  });

  sendBtn?.addEventListener('click', sendMessageHandler);

  const queueStatusEl = chatView.querySelector('#composer-queue-status') as HTMLElement | null;
  const renderQueueStatus = () => {
    if (!queueStatusEl) return;
    const queuedForConv = messageQueue.filter(q => q.conversationId === conversationId).length;
    if (queuedForConv === 0) {
      queueStatusEl.style.display = 'none';
      queueStatusEl.replaceChildren();
      return;
    }
    queueStatusEl.style.display = 'block';
    const offline = !navigator.onLine;
    queueStatusEl.replaceChildren(parseHTML(`${offline ? '🕐 Offline queue' : '🔄 Pending send'}: ${queuedForConv} message${queuedForConv === 1 ? '' : 's'} ${offline ? '(will auto-send when online)' : ''} <button id="retry-queued-now" class="btn btn-outline" style="margin-left:8px;font-size:11px;padding:3px 8px">Retry now</button>`));
    queueStatusEl.querySelector('#retry-queued-now')?.addEventListener('click', () => {
      void flushMessageQueue().then(() => {
        renderQueueStatus();
        const msgs = state.messages.get(conversationId);
        if (msgs) renderMessages(msgs);
      });
    });
  };
  renderQueueStatus();
  window.addEventListener('online', renderQueueStatus);
  window.addEventListener('offline', renderQueueStatus);
  window.addEventListener('rocchat:queue-updated', renderQueueStatus as EventListener);

  // Bind disappearing messages timer
  chatView.querySelector('#btn-disappear')?.addEventListener('click', () => {
    showDisappearingMenu(conversationId);
  });

  // Bind per-conversation notification mode picker
  chatView.querySelector('#btn-notif-mode')?.addEventListener('click', (e) => {
    showNotificationModeMenu(conversationId, e.currentTarget as HTMLElement);
  });

  // Bind per-conversation theme picker
  chatView.querySelector('#btn-chat-theme')?.addEventListener('click', () => {
    showConversationThemePicker(conversationId);
  });

  // Bind safety number verification
  chatView.querySelector('#btn-verify')?.addEventListener('click', () => {
    if (conv) showSafetyNumber(conv);
  });

  // Bind message search
  chatView.querySelector('#btn-search-messages')?.addEventListener('click', () => {
    toggleMessageSearch();
  });

  // Bind call buttons
  chatView.querySelector('#btn-voice-call')?.addEventListener('click', async () => {
    if (!conv) return;
    try {
      if (conv.type === 'group') {
        await startGroupCallFromChat(conv);
      } else {
        await startCall(conv, 'voice');
      }
    } catch {
      showToast('Voice call failed to start', 'error');
    }
  });
  chatView.querySelector('#btn-video-call')?.addEventListener('click', async () => {
    if (!conv) return;
    try {
      if (conv.type === 'group') {
        await startGroupCallFromChat(conv);
      } else {
        await startCall(conv, 'video');
      }
    } catch {
      showToast('Video call failed to start', 'error');
    }
  });

  // Bind pinned messages
  chatView.querySelector('#btn-pinned')?.addEventListener('click', () => {
    if (state.activeConversationId) showPinnedMessages(state.activeConversationId);
  });

  // Bind attach button
  chatView.querySelector('.composer .icon-btn[title="Attach file"]')?.addEventListener('click', () => {
    if (state.activeConversationId) showFileUpload(state.activeConversationId);
  });

  // Drag/drop upload on message area and composer.
  const dropZones = [
    chatView.querySelector('#messages-area') as HTMLElement | null,
    chatView.querySelector('.composer') as HTMLElement | null,
  ].filter(Boolean) as HTMLElement[];
  for (const zone of dropZones) {
    zone.addEventListener('dragover', (e) => {
      e.preventDefault();
      zone.classList.add('drag-upload-active');
    });
    zone.addEventListener('dragleave', () => zone.classList.remove('drag-upload-active'));
    zone.addEventListener('drop', (e) => {
      e.preventDefault();
      zone.classList.remove('drag-upload-active');
      const file = e.dataTransfer?.files?.[0];
      if (!file || !state.activeConversationId) return;
      showFileUpload(state.activeConversationId, file);
    });
  }

  // Bind vault button
  chatView.querySelector('#vault-btn')?.addEventListener('click', () => {
    if (state.activeConversationId) showVaultComposer();
  });

  // Bind priority button — cycle: normal → high → urgent → normal
  chatView.querySelector('#priority-btn')?.addEventListener('click', () => {
    const input = document.getElementById('message-input') as HTMLTextAreaElement;
    if (!input) return;
    const cur = input.dataset.priority || 'normal';
    const next = cur === 'normal' ? 'high' : cur === 'high' ? 'urgent' : 'normal';
    input.dataset.priority = next;
    const btn = document.getElementById('priority-btn');
    if (btn) {
      btn.style.color = next === 'urgent' ? '#DC3545' : next === 'high' ? '#E5A00D' : '';
      btn.title = next === 'normal' ? 'Set message priority' : `Priority: ${next}`;
    }
    // Show/remove indicator
    document.getElementById('priority-indicator')?.remove();
    if (next !== 'normal') {
      const ind = document.createElement('span');
      ind.id = 'priority-indicator';
      ind.style.cssText = 'font-size:11px;align-self:center;margin:0 4px;color:' + (next === 'urgent' ? '#DC3545' : '#E5A00D');
      ind.textContent = next === 'urgent' ? '🔴 Urgent' : '🟠 High';
      input.parentElement?.insertBefore(ind, input);
    }
  });

  // Voice note recording
  chatView.querySelector('#voice-note-btn')?.addEventListener('click', () => {
    if (state.activeConversationId) startVoiceRecording(state.activeConversationId);
  });

  // Video message recording
  chatView.querySelector('#video-note-btn')?.addEventListener('click', () => {
    if (state.activeConversationId) startVideoRecording(state.activeConversationId);
  });

  // Emoji picker
  const emojiBtn = chatView.querySelector('#emoji-btn') as HTMLElement;
  const emojiContainer = chatView.querySelector('#emoji-picker') as HTMLElement;
  if (emojiBtn && emojiContainer && input) {
    initEmojiPicker(emojiContainer, emojiBtn, (emoji) => {
      input.value += emoji;
      input.dispatchEvent(new Event('input'));
      input.focus();
    });
  }

  // GIF picker
  const gifBtn = chatView.querySelector('#gif-btn') as HTMLElement;
  const gifContainer = chatView.querySelector('#gif-picker') as HTMLElement;
  if (gifBtn && gifContainer) {
    initGifPicker(gifContainer, gifBtn, (gifUrl, previewUrl, w, h) => {
      // Send GIF as a special message type
      sendGifMessage(conversationId, gifUrl, previewUrl, w, h);
    });
  }

  // Schedule message button
  chatView.querySelector('#schedule-btn')?.addEventListener('click', () => {
    if (!input?.value.trim()) {
      showToast('Type a message first', 'info');
      return;
    }
    showScheduleDialog(conversationId, input);
  });

  // Voice-to-text dictation
  const voiceBtn = chatView.querySelector('#voice-btn') as HTMLElement | null;
  if (voiceBtn && input) {
    voiceBtn.addEventListener('click', () => toggleVoiceTranscription(input, voiceBtn));
  }
  // Per-message disappear timer
  chatView.querySelector('#msg-timer-btn')?.addEventListener('click', (e) => {
    openPerMessageTimerMenu(e.currentTarget as HTMLElement);
  });
  // Group moderation (group conversations only)
  chatView.querySelector('#btn-group-admin')?.addEventListener('click', () => {
    if (state.activeConversationId) openGroupAdminDialog(state.activeConversationId);
  });

  if (typeof (window as any).lucide !== 'undefined') {
    (window as any).lucide.createIcons();
  }
}

async function loadMessages(conversationId: string) {
  const area = document.getElementById('messages-area');
  if (!area) return;

  try {
    const res = await api.getMessages(conversationId);
    if (res.ok) {
      const msgs = res.data.messages || [];
      state.messages.set(conversationId, msgs);
      renderMessages(msgs);
      // Batch-load reactions for visible messages
      loadReactionsForMessages(msgs);
    }
  } catch {
    // Offline — show cached
  }
}

/** Fetch and display reactions for all messages in the current view */
async function loadReactionsForMessages(msgs: Message[]) {
  for (const msg of msgs) {
    try {
      const res = await api.getReactions(msg.id) as { ok: boolean; data?: { reactions?: { user_id: string; emoji: string }[] } };
      if (res.ok && res.data?.reactions?.length) {
        for (const r of res.data.reactions) {
          updateReactionUI(msg.id, r.user_id, r.emoji);
        }
      }
    } catch { /* ignore per-message failures */ }
  }
}

/** Apply decrypted plaintext content to a message row (shared by cache-hit and async-decrypt paths) */
function applyDecryptedContent(div: HTMLElement, plaintext: string, isMine: boolean, msg: Message) {
  // Screenshot alert — replace bubble with centered system notification
  if (msg.message_type === 'screenshot_alert' || plaintext === '📸 Screenshot taken') {
    const senderName = (msg as any).sender_name || (msg as any).sender_username || 'Someone';
    div.className = 'message-row system-notification';
    div.removeAttribute('aria-label');
    div.setAttribute('role', 'status');
    div.replaceChildren(parseHTML(`<div class="system-message screenshot-alert">📸 ${escapeHtml(senderName)} took a screenshot</div>`));
    return;
  }

  const gif = tryParseGif(plaintext);
  const fileMsg = tryParseFileMessage(plaintext);
  const bubble = div.querySelector('.message-bubble');
  if (gif && bubble) {
    bubble.classList.add('gif-bubble');
    const textEl = bubble.querySelector('.message-text');
    if (textEl) {
      const img = document.createElement('img');
      img.src = gif.preview || gif.url;
      img.alt = 'GIF';
      img.className = 'gif-message';
      img.decoding = 'async';
      img.style.cssText = 'max-width:240px;max-height:200px;border-radius:12px;cursor:pointer';
      textEl.replaceWith(img);
    }
  } else if (fileMsg && bubble) {
    renderFileMessage(bubble, fileMsg, msg.conversation_id);
  } else if (plaintext.startsWith('{"type":"vault_item"')) {
    try {
      const vault = JSON.parse(plaintext);
      renderVaultItem(bubble!, vault);
    } catch { if (bubble) { const t = bubble.querySelector('.message-text'); if (t) t.textContent = plaintext; } }
  } else {
    const textEl = div.querySelector('.message-text');
    if (textEl) {
      (textEl as HTMLElement).replaceChildren(parseHTML(renderCustomEmoji(plaintext, true)));
      const bubbleEl = div.querySelector('.message-bubble') as HTMLElement | null;
      if (bubbleEl) attachPreviewIfAny(bubbleEl, plaintext);
    }
  }
}

function renderMessages(messages: Message[]) {
  const area = document.getElementById('messages-area');
  if (!area) return;

  const userId = localStorage.getItem('rocchat_user_id') || '';
  const now = Math.floor(Date.now() / 1000);

  // Filter expired disappearing messages client-side
  const visible = messages.filter(m => !m.expires_at || m.expires_at > now)
    .filter(m => m.message_type !== 'sender_key_distribution');

  // Ensure encryption banner exists
  if (!area.querySelector('.encryption-banner')) {
    const banner = document.createElement('div');
    banner.className = 'encryption-banner';
    banner.replaceChildren(parseHTML('🔒 Messages are end-to-end encrypted'));
    area.prepend(banner);
  }

  // Build lookup of existing rendered nodes
  const existingNodes = new Map<string, HTMLElement>();
  area.querySelectorAll<HTMLElement>('.message-row[data-msg-id]').forEach((el) => {
    existingNodes.set(el.dataset.msgId!, el);
  });

  const newIds = new Set(visible.map(m => m.id));

  // Remove nodes for messages no longer in the list (deleted, expired)
  existingNodes.forEach((el, id) => {
    if (!newIds.has(id)) el.remove();
  });

  // Track whether we should auto-scroll (only if already near bottom)
  const wasAtBottom = area.scrollHeight - area.scrollTop - area.clientHeight < 80;

  let prevChild: Element | null = area.querySelector('.encryption-banner');

  // Remove stale date separators before re-rendering
  area.querySelectorAll('.date-separator').forEach(el => el.remove());

  let lastDateLabel = '';
  let lastSenderId = '';
  let lastTimestamp = 0;

  visible.forEach((msg, idx) => {
    const isMine = msg.sender_id === userId;

    // ── Date separator ──
    const msgDate = new Date(msg.created_at);
    const dateLabel = formatDateLabel(msgDate);
    if (dateLabel !== lastDateLabel) {
      lastDateLabel = dateLabel;
      lastSenderId = '';
      const dateSep = document.createElement('div');
      dateSep.className = 'date-separator';
      dateSep.setAttribute('role', 'separator');
      dateSep.textContent = dateLabel;
      if (prevChild) prevChild.after(dateSep); else area.prepend(dateSep);
      prevChild = dateSep;
    }

    // ── Message grouping ──
    const msgTs = msgDate.getTime();
    const sameGroup = msg.sender_id === lastSenderId && (msgTs - lastTimestamp) < 120_000;
    const nextMsg = visible[idx + 1];
    const nextSameGroup = nextMsg && nextMsg.sender_id === msg.sender_id &&
      new Date(nextMsg.created_at).getTime() - msgTs < 120_000;

    lastSenderId = msg.sender_id;
    lastTimestamp = msgTs;

    // If this message row already exists, skip recreation — just ensure order
    const existing = existingNodes.get(msg.id);
    if (existing) {
      existing.classList.toggle('group-first', !sameGroup);
      existing.classList.toggle('group-middle', sameGroup && !!nextSameGroup);
      existing.classList.toggle('group-last', sameGroup && !nextSameGroup);
      existing.classList.toggle('group-solo', !sameGroup && !nextSameGroup);
      // Update status icon (delivery/read receipts may have changed)
      const metaEl = existing.querySelector('.message-meta');
      if (metaEl && isMine) {
        const statusEl = metaEl.querySelector('.message-status');
        const newStatus = getStatusIcon(msg.id, isMine);
        if (statusEl && newStatus) statusEl.outerHTML = newStatus;
      }
      // Update edited indicator
      if (msg.edited_at && !existing.querySelector('.message-edited')) {
        const timeEl = existing.querySelector('.message-time');
        if (timeEl) timeEl.insertAdjacentHTML('beforebegin', '<span class="message-edited" title="Edited">edited</span>');
      }
      // Update deleted state
      if (msg.deleted_at && !existing.querySelector('.message-deleted')) {
        const bubble = existing.querySelector('.message-bubble');
        if (bubble) bubble.replaceChildren(parseHTML('<em>🚫 This message was deleted</em>'));
        existing.querySelector('.message-bubble')?.classList.add('message-deleted');
      }
      // Ensure correct DOM order
      if (prevChild && prevChild.nextElementSibling !== existing) {
        prevChild.after(existing);
      }
      prevChild = existing;
      return;
    }

    // ── Create new message row ──
    const div = document.createElement('div');
    div.dataset.msgId = msg.id;

    // Screenshot alert — render as centered system notification inline in chat
    if (msg.message_type === 'screenshot_alert') {
      const senderName = (msg as any).sender_name || (msg as any).sender_username || 'Someone';
      div.className = 'message-row system-notification';
      div.setAttribute('role', 'status');
      div.replaceChildren(parseHTML(`<div class="system-message screenshot-alert">📸 ${escapeHtml(senderName)} took a screenshot</div>`));
      if (prevChild) prevChild.after(div); else area.prepend(div);
      prevChild = div;
      return;
    }

    const groupClass = !sameGroup && !nextSameGroup ? 'group-solo' : !sameGroup ? 'group-first' : nextSameGroup ? 'group-middle' : 'group-last';
    div.className = `message-row ${isMine ? 'mine' : 'theirs'} ${groupClass}`;
    div.setAttribute('role', 'article');
    div.setAttribute('aria-label', `${isMine ? 'You' : 'Message'} at ${formatTime(msg.created_at)}`);

    if (msg.deleted_at) {
      div.replaceChildren(parseHTML(`<div class="message-bubble message-deleted"><em>🚫 This message was deleted</em></div>`));
      if (prevChild) prevChild.after(div); else area.prepend(div);
      prevChild = div;
      return;
    }

    const hasRatchet = msg.ratchet_header && msg.iv && msg.ciphertext;
    const displayText = hasRatchet ? '🔒 Decrypting...' : msg.ciphertext;
    const gifContent = tryParseGif(displayText);

    // Build reply quote if this message is a reply
    let replyQuoteHtml = '';
    if (msg.reply_to) {
      const quotedPlain = plaintextCache.get(msg.reply_to);
      const quotedSnippet = quotedPlain
        ? escapeHtml(quotedPlain.length > 80 ? quotedPlain.slice(0, 80) + '…' : quotedPlain)
        : '🔒 Encrypted message';
      replyQuoteHtml = `<div class="reply-quote" data-reply-id="${escapeHtml(msg.reply_to)}">${quotedSnippet}</div>`;
    }

    const priorityBadge = msg.priority === 'urgent' ? '<span class="priority-badge urgent" title="Urgent">🔴</span>'
      : msg.priority === 'high' ? '<span class="priority-badge high" title="High Priority">🟠</span>' : '';
    div.replaceChildren(parseHTML(`
      <div class="message-bubble${gifContent ? ' gif-bubble' : ''}${msg.priority && msg.priority !== 'normal' ? ' priority-' + msg.priority : ''}">
        ${priorityBadge}
        ${replyQuoteHtml}
        ${gifContent
          ? `<img src="${escapeHtml(gifContent.preview || gifContent.url)}" alt="GIF" class="gif-message" loading="lazy" decoding="async" style="max-width:240px;max-height:200px;border-radius:12px;cursor:pointer" />`
          : `<div class="message-text">${escapeHtml(displayText)}</div>`
        }
        <div class="message-reactions-row" id="reactions-${msg.id}"></div>
        <div class="message-meta">
          <span class="message-lock">🔒</span>
          ${msg.edited_at ? '<span class="message-edited" title="Edited">edited</span>' : ''}
          <span class="message-time">${formatTime(msg.created_at)}</span>
          ${getStatusIcon(msg.id, isMine)}
        </div>
      </div>
    `));
    div.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      showMessageContextMenu(e as MouseEvent, msg.id, isMine, msg.conversation_id);
    });

    if (prevChild) prevChild.after(div); else area.prepend(div);
    prevChild = div;

    // Async decrypt
    if (hasRatchet) {
      const cached = plaintextCache.get(msg.id);
      if (cached !== undefined) {
        applyDecryptedContent(div, cached, isMine, msg);
        return;
      }

      let header;
      try { header = JSON.parse(msg.ratchet_header); } catch {
        const textEl = div.querySelector('.message-text');
        if (textEl) textEl.textContent = '🔒 Unable to decrypt';
        return;
      }

      const decryptPromise = isGroupEncrypted(msg.ratchet_header)
        ? groupDecrypt(msg.conversation_id, msg.sender_id, msg.ciphertext, msg.ratchet_header)
        : decryptMessage(msg.conversation_id, {
            header,
            ciphertext: msg.ciphertext,
            iv: msg.iv,
            tag: msg.tag || header.tag || '',
          } as EncryptedMessage);

      decryptPromise
        .then((plaintext) => {
          cachePlaintext(msg.id, plaintext, msg.conversation_id, msg.created_at);
          const snippet = plaintext.length > 80 ? plaintext.slice(0, 80) + '…' : plaintext;
          div.setAttribute('aria-label', `${isMine ? 'You' : 'Message'} at ${formatTime(msg.created_at)}: ${snippet}`);
          applyDecryptedContent(div, plaintext, isMine, msg);
        })
        .catch(() => {
          const textEl = div.querySelector('.message-text');
          if (textEl) textEl.textContent = '🔒 Unable to decrypt';
        });
    }
  });

  if (wasAtBottom) area.scrollTop = area.scrollHeight;

  // Send encrypted read receipts for unread messages from others
  const unreadIds = messages
    .filter(m => m.sender_id !== userId && deliveryStatus.get(m.id) !== 'read')
    .map(m => m.id);
  if (unreadIds.length && state.ws?.readyState === WebSocket.OPEN && state.activeConversationId) {
    encryptMeta(state.activeConversationId, { messageIds: unreadIds }).then(enc => {
      state.ws?.send(JSON.stringify({ type: 'read_receipt', payload: { e: enc } }));
    }).catch(() => {});
  }
}

async function sendMessageHandler() {
  const input = document.getElementById('message-input') as HTMLTextAreaElement;
  const sendBtn = document.getElementById('send-btn') as HTMLButtonElement;
  if (!input || !state.activeConversationId) return;

  const text = input.value.trim();
  if (!text) return;
  haptic();

  // Prevent huge payloads from reaching the server
  if (text.length > 64 * 1024) {
    showToast('Message is too long (max 64 KB)', 'error');
    return;
  }
  const replyTo = input.dataset.replyTo || undefined;
  delete input.dataset.replyTo;
  document.getElementById('reply-banner')?.remove();

  // Capture and clear priority
  const msgPriority = (input.dataset.priority || 'normal') as 'normal' | 'high' | 'urgent';
  delete input.dataset.priority;
  const priorityIndicator = document.getElementById('priority-indicator');
  if (priorityIndicator) priorityIndicator.remove();

  input.value = '';
  input.style.height = 'auto';
  sendBtn.disabled = true;
  void deleteSecret(`rocchat_draft_${state.activeConversationId}`);
  localStorage.removeItem(`rocchat_draft_${state.activeConversationId}`); // clean legacy

  // Nudge for push notification permission after the user's 3rd message.
  // Asking on first load is hostile; asking after 3 sends means they have
  // committed to the app and getting notified for replies is genuinely
  // useful. Stops nagging after a permanent decision.
  try {
    const COUNT_KEY = 'rocchat_send_count';
    const NUDGE_KEY = 'rocchat_push_nudge_v1';
    const sent = parseInt(localStorage.getItem(COUNT_KEY) || '0', 10) + 1;
    localStorage.setItem(COUNT_KEY, String(sent));
    if (
      sent >= 3 &&
      !localStorage.getItem(NUDGE_KEY) &&
      'Notification' in window &&
      Notification.permission === 'default'
    ) {
      localStorage.setItem(NUDGE_KEY, '1');
      // Defer so the message UI updates first, then show a non-blocking toast
      // with an action that triggers the system permission prompt.
      setTimeout(() => {
        const t = document.createElement('div');
        t.className = 'push-nudge-toast';
        t.setAttribute('role', 'dialog');
        t.setAttribute('aria-label', 'Enable push notifications');
        t.replaceChildren(parseHTML(`
          <span style="flex:1">🔔 Get notified when someone replies?</span>
          <button class="btn-secondary push-nudge-yes" style="font-size:12px;padding:4px 10px">Enable</button>
          <button class="btn-secondary push-nudge-no"  style="font-size:12px;padding:4px 10px">Not now</button>
        `));
        Object.assign(t.style, {
          position: 'fixed', bottom: '20px', left: '50%', transform: 'translateX(-50%)',
          background: 'var(--bg-elevated)', color: 'var(--text-primary)',
          border: '1px solid var(--roc-gold,#D4AF37)', borderRadius: '12px',
          padding: '10px 14px', display: 'flex', gap: '10px', alignItems: 'center',
          boxShadow: '0 4px 18px rgba(0,0,0,0.25)', zIndex: '60', maxWidth: '92vw',
        } as Partial<CSSStyleDeclaration>);
        document.body.appendChild(t);
        const close = () => t.remove();
        t.querySelector('.push-nudge-no')?.addEventListener('click', close);
        t.querySelector('.push-nudge-yes')?.addEventListener('click', async () => {
          close();
          const enable = (window as unknown as { __rocchatEnablePush?: () => Promise<void> }).__rocchatEnablePush;
          if (enable) await enable();
        });
        setTimeout(close, 12000);
      }, 600);
    }
  } catch { /* localStorage unavailable */ }

  const conv = state.conversations.find((c) => c.id === state.activeConversationId);
  const userId = localStorage.getItem('rocchat_user_id') || '';
  const recipientUserId = conv?.members.find((m) => m.user_id !== userId)?.user_id;
  const localId = `queued-${Date.now()}`;
  const messageNonce = crypto.randomUUID();

  try {
    const expiresIn = consumeOneShotExpiry() ?? (disappearTimers.get(state.activeConversationId) || undefined);
    let payload: Parameters<typeof api.sendMessage>[0];

    if (recipientUserId) {
      // Encrypt with Double Ratchet
      const encrypted = await encryptMessage(state.activeConversationId, recipientUserId, text);
      // Include X3DH header and tag in ratchet_header so iOS can decode it
      const enc = encrypted as unknown as Record<string, unknown>;
      const headerObj = {
        ...encrypted.header,
        tag: encrypted.tag,
        ...(enc.x3dh ? { x3dh: enc.x3dh } : {}),
      };
      payload = {
        conversation_id: state.activeConversationId,
        ciphertext: encrypted.ciphertext,
        iv: encrypted.iv,
        tag: encrypted.tag,
        ratchet_header: JSON.stringify(headerObj),
        message_nonce: messageNonce,
        message_type: 'text',
        expires_in: expiresIn,
        reply_to: replyTo,
        priority: msgPriority !== 'normal' ? msgPriority : undefined,
      };
    } else if (conv?.type === 'group') {
      // Group encryption with Sender Keys (any group, including 2-member)
      const groupEnc = await groupEncrypt(state.activeConversationId, conv.members, text);
      payload = {
        conversation_id: state.activeConversationId,
        ciphertext: groupEnc.ciphertext,
        iv: groupEnc.iv,
        ratchet_header: groupEnc.ratchet_header,
        message_nonce: messageNonce,
        message_type: 'text',
        expires_in: expiresIn,
        reply_to: replyTo,
        priority: msgPriority !== 'normal' ? msgPriority : undefined,
      };
    } else {
      // No valid encryption path available — refuse to send plaintext
      console.error('Cannot send: no encryption session available for this conversation');
      return;
    }

    // Optimistic: add message to local view
    const msgs = state.messages.get(state.activeConversationId) || [];
    msgs.push({
      id: localId,
      conversation_id: state.activeConversationId,
      sender_id: userId,
      ciphertext: text,
      iv: '',
      ratchet_header: '',
      message_type: 'text',
      created_at: new Date().toISOString(),
      reply_to: replyTo,
    });
    state.messages.set(state.activeConversationId, msgs);
    renderMessages(msgs);

    // Try to send; queue on failure
    try {
      const res = await api.sendMessage(payload);
      const mid = (res as { ok: boolean; data?: { message_id?: string } }).data?.message_id;
      if (mid) cachePlaintext(mid, text);
    } catch {
      const queueItem: QueuedMessage = {
        payload,
        localId,
        conversationId: state.activeConversationId,
      };
      messageQueue.push(queueItem);
      notifyQueueUpdated();
      persistQueueItem(queueItem);
      // Register background sync so SW retries when connectivity returns
      navigator.serviceWorker?.ready?.then(reg => (reg as any).sync?.register?.('message-queue')).catch(() => {});
      showToast('Message queued — will send when online', 'error');
    }
  } catch {
    input.value = text;
    sendBtn.disabled = false;
    showToast('Failed to encrypt message', 'error');
  }
}

async function sendGifMessage(conversationId: string, gifUrl: string, previewUrl: string, w: number, h: number) {
  const userId = localStorage.getItem('rocchat_user_id') || '';
  const conv = state.conversations.find((c) => c.id === conversationId);
  const recipientUserId = conv?.members.find((m) => m.user_id !== userId)?.user_id;

  const gifPayload = JSON.stringify({ type: 'gif', url: gifUrl, preview: previewUrl, width: w, height: h });

  try {
    let payload: Parameters<typeof api.sendMessage>[0];
    if (conv?.type === 'group') {
      const groupEnc = await groupEncrypt(conversationId, conv.members, gifPayload);
      payload = { conversation_id: conversationId, ciphertext: groupEnc.ciphertext, iv: groupEnc.iv, ratchet_header: groupEnc.ratchet_header, message_type: 'gif' };
    } else if (recipientUserId) {
      const encrypted = await encryptMessage(conversationId, recipientUserId, gifPayload);
      const enc = encrypted as unknown as Record<string, unknown>;
      const headerObj = enc.x3dh ? { ...encrypted.header, x3dh: enc.x3dh } : encrypted.header;
      payload = { conversation_id: conversationId, ciphertext: encrypted.ciphertext, iv: encrypted.iv, ratchet_header: JSON.stringify(headerObj), message_type: 'gif' };
    } else {
      showToast('Cannot send: no encryption session', 'error');
      return;
    }

    // Optimistic local add
    const msgs = state.messages.get(conversationId) || [];
    msgs.push({
      id: `local-${Date.now()}`, conversation_id: conversationId, sender_id: userId,
      ciphertext: gifPayload, iv: '', ratchet_header: '', message_type: 'gif',
      created_at: new Date().toISOString(),
    });
    state.messages.set(conversationId, msgs);
    renderMessages(msgs);

    await api.sendMessage(payload);
  } catch {
    showToast('Failed to send GIF', 'error');
  }
}

async function connectWebSocket(conversationId: string) {
  // Close existing WS
  if (state.ws) {
    state.ws.close();
    state.ws = null;
  }

  const token = api.getToken();
  const userId = localStorage.getItem('rocchat_user_id') || '';
  if (!token || !userId) return;

  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
  // Connect directly to the Worker backend — the Pages Function proxy
  // cannot handle WebSocket upgrade requests (fetch() strips Upgrade header).
  const wsHost = location.hostname === 'localhost' ? location.host : 'rocchat-api.spoass.workers.dev';
  const deviceId = localStorage.getItem('rocchat_device_id') || 'web';

  // Get a short-lived WS ticket to avoid putting session token in the URL
  let wsUrl: string;
  try {
    const ticketRes = await api.getWsTicket();
    if (ticketRes.ok && ticketRes.data?.ticket) {
      wsUrl = `${proto}//${wsHost}/api/ws/${conversationId}?userId=${userId}&deviceId=${deviceId}&ticket=${ticketRes.data.ticket}`;
    } else {
      // Retry once before falling back
      const retry = await api.getWsTicket();
      if (retry.ok && retry.data?.ticket) {
        wsUrl = `${proto}//${wsHost}/api/ws/${conversationId}?userId=${userId}&deviceId=${deviceId}&ticket=${retry.data.ticket}`;
      } else {
        console.warn('WS ticket unavailable, skipping connection');
        showToast('Realtime reconnect unavailable. Please refresh.', 'error');
        return;
      }
    }
  } catch {
    try {
      const retry = await api.getWsTicket();
      if (retry.ok && retry.data?.ticket) {
        wsUrl = `${proto}//${wsHost}/api/ws/${conversationId}?userId=${userId}&deviceId=${deviceId}&ticket=${retry.data.ticket}`;
      } else {
        console.warn('WS ticket unavailable, skipping connection');
        showToast('Realtime reconnect unavailable. Please refresh.', 'error');
        return;
      }
    } catch {
      console.warn('WS ticket fetch failed, skipping connection');
      showToast('Realtime reconnect failed. Please refresh.', 'error');
      return;
    }
  }

  try {
    const ws = new WebSocket(wsUrl);
    state.ws = ws;

    ws.addEventListener('open', () => {
      // Successful connect resets backoff.
      wsReconnectAttempts.delete(conversationId);
      if (messageQueue.length > 0) flushMessageQueue();
    });

    ws.addEventListener('message', async (event) => {
      try {
        const data = JSON.parse(event.data);

        switch (data.type) {
          case 'message': {
            const payload = data.payload;
            const msgs = state.messages.get(conversationId) || [];
            const senderId = payload.fromUserId || payload.sender_id;

            // Handle sender key distribution (not a visible message)
            if (payload.message_type === 'sender_key_distribution') {
              try {
                await handleSenderKeyDistribution(
                  conversationId, senderId,
                  payload.ciphertext, payload.iv, payload.ratchet_header,
                );
              } catch { /* best effort */ }
              break;
            }

            // Try to decrypt
            let displayText = payload.ciphertext || '';
            if (payload.ratchet_header && payload.iv) {
              try {
                let header;
                if (typeof payload.ratchet_header === 'string') {
                  header = JSON.parse(payload.ratchet_header);
                } else {
                  header = payload.ratchet_header;
                }

                if (isGroupEncrypted(typeof payload.ratchet_header === 'string' ? payload.ratchet_header : JSON.stringify(payload.ratchet_header))) {
                  // Group message — decrypt with Sender Keys
                  displayText = await groupDecrypt(
                    conversationId, senderId,
                    payload.ciphertext, typeof payload.ratchet_header === 'string' ? payload.ratchet_header : JSON.stringify(payload.ratchet_header),
                  );
                } else {
                  // Direct message — decrypt with Double Ratchet
                  const encrypted: EncryptedMessage = {
                    header,
                    ciphertext: payload.ciphertext,
                    iv: payload.iv,
                    tag: payload.tag || header.tag || '',
                  };
                  displayText = await decryptMessage(conversationId, encrypted);
                }
              } catch {
                displayText = '🔒 Unable to decrypt';
              }
            }

            msgs.push({
              id: payload.id || `ws-${Date.now()}`,
              conversation_id: conversationId,
              sender_id: senderId,
              ciphertext: displayText,
              iv: '',
              ratchet_header: '',
              message_type: payload.message_type || 'text',
              created_at: payload.created_at || new Date().toISOString(),
            });
            state.messages.set(conversationId, msgs);
            renderMessages(msgs);

            // Keyword alert check — break through DND with browser notification
            if (senderId !== localStorage.getItem('rocchat_user_id')) {
              try {
                const keywords: string[] = JSON.parse(localStorage.getItem('rocchat_alert_keywords') || '[]');
                if (keywords.length && displayText) {
                  const lower = displayText.toLowerCase();
                  const matched = keywords.find(kw => lower.includes(kw));
                  if (matched && Notification.permission === 'granted') {
                    new Notification('⚠️ Keyword Alert — RocChat', {
                      body: `Message contains "${matched}"`,
                      tag: 'keyword-alert',
                      requireInteraction: true,
                    });
                  }
                }
              } catch { /* ignore */ }
            }
            break;
          }

          case 'typing': {
            const typingEl = document.querySelector('.chat-header-status');
            if (typingEl) {
              const enc = data.payload.e as string | undefined;
              if (enc) {
                decryptMeta(conversationId, enc).then(meta => {
                  if (meta.isTyping) {
                    typingEl.replaceChildren(parseHTML(`<span class="typing-indicator"><span></span><span></span><span></span></span> typing...`));
                    setTimeout(() => {
                      if (typingEl) typingEl.replaceChildren(parseHTML(`<span style="font-size:8px">🔒</span> End-to-end encrypted`));
                    }, 3000);
                  }
                }).catch(() => {});
              }
              // Unencrypted typing indicators are silently dropped
            }
            break;
          }

          case 'presence': {
            const presUserId = data.payload.userId as string;
            const presStatus = data.payload.status as string;
            if (presStatus === 'online') {
              onlineUsers.add(presUserId);
            } else {
              onlineUsers.delete(presUserId);
            }
            // Update presence dot in chat header
            const statusEl = document.querySelector('.chat-header-status');
            if (statusEl) {
              statusEl.setAttribute('data-online', presStatus === 'online' ? 'true' : 'false');
            }
            // Update presence dots on avatars
            document.querySelectorAll(`.presence-dot[data-uid="${presUserId}"]`).forEach((dot) => {
              dot.classList.toggle('online', presStatus === 'online');
            });
            break;
          }

          case 'read_receipt': {
            const enc = data.payload.e as string | undefined;
            const applyReceipts = (ids: string[]) => {
              ids.forEach((id: string) => {
                deliveryStatus.set(id, 'read');
                const el = document.querySelector(`[data-msg-id="${id}"] .message-status`);
                if (el) { el.textContent = '✓✓'; el.classList.add('message-status-read'); }
              });
            };
            if (enc) {
              decryptMeta(conversationId, enc).then(meta => {
                const ids = meta.messageIds as string[] | undefined;
                if (ids) applyReceipts(ids);
              }).catch(() => {});
            }
            // Unencrypted read receipts are silently dropped
            break;
          }

          case 'call_offer': {
            handleIncomingCall(data.payload, conversationId);
            break;
          }

          case 'call_answer': {
            import('../calls/calls.js').then((mod) => {
              mod.handleCallAnswer(data.payload);
            });
            break;
          }

          case 'call_ice': {
            import('../calls/calls.js').then((mod) => {
              mod.handleIceCandidate(data.payload);
            });
            break;
          }

          case 'call_end': {
            import('../calls/calls.js').then((mod) => {
              mod.handleCallEnd(data.payload);
            });
            break;
          }

          case 'call_audio': {
            import('../calls/calls.js').then((mod) => {
              mod.handleCallAudio(data.payload);
            });
            break;
          }

          case 'call_video': {
            import('../calls/calls.js').then((mod) => {
              mod.handleCallVideo(data.payload);
            });
            break;
          }

          // Group call signaling
          case 'group_call_start': {
            import('../calls/calls.js').then((mod) => {
              mod.handleGroupCallStart(data.payload, conversationId, state.ws);
            });
            break;
          }
          case 'group_call_join': {
            import('../calls/calls.js').then((mod) => {
              mod.handleGroupCallJoin(data.payload);
            });
            break;
          }
          case 'group_call_offer': {
            import('../calls/calls.js').then((mod) => {
              mod.handleGroupCallOffer(data.payload);
            });
            break;
          }
          case 'group_call_answer': {
            import('../calls/calls.js').then((mod) => {
              mod.handleGroupCallAnswer(data.payload);
            });
            break;
          }
          case 'group_call_ice': {
            import('../calls/calls.js').then((mod) => {
              mod.handleGroupCallIce(data.payload);
            });
            break;
          }
          case 'group_call_leave': {
            import('../calls/calls.js').then((mod) => {
              mod.handleGroupCallLeave(data.payload);
            });
            break;
          }

          case 'reaction': {
            const { message_id, user_id, encrypted_reaction } = data.payload;
            let reactionEmoji = encrypted_reaction;
            if (encrypted_reaction && user_id !== localStorage.getItem('rocchat_user_id')) {
              try { reactionEmoji = await decryptProfileField(encrypted_reaction); } catch { reactionEmoji = encrypted_reaction; }
            }
            updateReactionUI(message_id, user_id, reactionEmoji);
            break;
          }

          case 'message_edit': {
            const { message_id, encrypted, sender_id: editSenderId } = data.payload;
            const editMsgs = state.messages.get(conversationId);
            const editMsg = editMsgs?.find(m => m.id === message_id);
            if (editMsg) {
              let editDisplay = '[Unable to decrypt]';
              try {
                const encObj = typeof encrypted === 'string' ? JSON.parse(encrypted) : encrypted;
                const rh = encObj.ratchet_header || '';
                if (isGroupEncrypted(typeof rh === 'string' ? rh : JSON.stringify(rh))) {
                  editDisplay = await groupDecrypt(conversationId, editSenderId || editMsg.sender_id, encObj.ciphertext, typeof rh === 'string' ? rh : JSON.stringify(rh));
                } else if (encObj.iv && rh) {
                  const hdr = typeof rh === 'string' ? JSON.parse(rh) : rh;
                  editDisplay = await decryptMessage(conversationId, { header: hdr, ciphertext: encObj.ciphertext, iv: encObj.iv, tag: encObj.tag || hdr.tag || '' });
                }
              } catch {
                editDisplay = '[Unable to decrypt]';
              }
              editMsg.ciphertext = editDisplay;
              editMsg.edited_at = Date.now();
              renderMessages(editMsgs!);
            }
            break;
          }

          case 'message_delete': {
            const { message_id: delId } = data.payload;
            const delMsgs = state.messages.get(conversationId);
            const delMsg = delMsgs?.find(m => m.id === delId);
            if (delMsg) {
              delMsg.deleted_at = Date.now();
              renderMessages(delMsgs!);
            }
            break;
          }

          case 'message_pin': {
            const { message_id: pinId, pinned } = data.payload;
            showToast(pinned ? 'Message pinned' : 'Message unpinned', 'info');
            break;
          }
        }
      } catch { /* ignore malformed */ }
    });

    ws.addEventListener('close', () => {
      state.ws = null;
      // Auto-reconnect with exponential backoff (1→2→4→8→16→32→60s) + jitter.
      // Reset the attempt counter after a stable connection (handled in 'open').
      const attempt = wsReconnectAttempts.get(conversationId) ?? 0;
      const stepsSeconds = [1, 2, 4, 8, 16, 32, 60];
      const base = stepsSeconds[Math.min(attempt, stepsSeconds.length - 1)] * 1000;
      const jitter = Math.floor(Math.random() * 500);
      const delay = base + jitter;
      wsReconnectAttempts.set(conversationId, attempt + 1);
      setTimeout(() => {
        if (state.activeConversationId === conversationId && !state.ws) {
          connectWebSocket(conversationId);
        }
      }, delay);
    });

    ws.addEventListener('error', () => {
      // Error will also trigger close event → reconnect handled there
    });

    // Send encrypted typing indicators
    const input = document.getElementById('message-input');
    let typingTimeout: ReturnType<typeof setTimeout>;
    let lastTypingSent = 0;
    const TYPING_THROTTLE = 3000; // Only send typing:true at most once per 3s
    input?.addEventListener('input', () => {
      if (!state.ws || state.ws.readyState !== WebSocket.OPEN) return;
      clearTimeout(typingTimeout);
      const now = Date.now();
      if (now - lastTypingSent >= TYPING_THROTTLE) {
        lastTypingSent = now;
        encryptMeta(conversationId, { isTyping: true }).then(enc => {
          state.ws?.send(JSON.stringify({ type: 'typing', payload: { e: enc } }));
        }).catch(() => {});
      }
      typingTimeout = setTimeout(() => {
        if (state.ws?.readyState === WebSocket.OPEN) {
          encryptMeta(conversationId, { isTyping: false }).then(enc => {
            state.ws?.send(JSON.stringify({ type: 'typing', payload: { e: enc } }));
          }).catch(() => {});
        }
      }, 2000);
    });
  } catch {
    // WebSocket not available
  }
}

function handleIncomingCall(payload: Record<string, unknown>, conversationId: string) {
  // Import dynamically to avoid circular deps
  import('../calls/calls.js').then((mod) => {
    if ('handleIncomingCallOffer' in mod) {
      (mod as any).handleIncomingCallOffer(payload, conversationId, state.ws);
    }
  });
}

function showNewChatDialog(container: HTMLElement) {
  const overlay = document.createElement('div');
  overlay.style.cssText = `
    position:fixed;inset:0;background:rgba(0,0,0,0.5);z-index:50;
    display:flex;align-items:center;justify-content:center;padding:var(--sp-4);
  `;
  overlay.replaceChildren(parseHTML(`
    <div class="auth-card" style="max-width:400px">
      <h2 style="font-size:var(--text-lg);margin-bottom:var(--sp-4)">New Conversation</h2>
      <div style="display:flex;gap:var(--sp-2);margin-bottom:var(--sp-4)">
        <button class="btn-secondary" id="mode-direct" style="flex:1;opacity:1">Direct</button>
        <button class="btn-secondary" id="mode-group" style="flex:1;opacity:0.5">Group</button>
      </div>
      <div id="group-name-section" style="display:none;margin-bottom:var(--sp-3)">
        <label class="form-label">Group name</label>
        <input type="text" placeholder="Group name" id="group-name-input" style="width:100%;padding:8px;border-radius:8px;border:1px solid var(--border);background:var(--bg-secondary);color:var(--text-primary)" />
      </div>
      <div class="form-group">
        <label class="form-label">Search by username</label>
        <div class="search-box">
          <input type="text" placeholder="@username" id="search-user-input" />
        </div>
      </div>
      <div id="selected-members" style="display:none;margin-bottom:var(--sp-3);display:flex;flex-wrap:wrap;gap:var(--sp-1)"></div>
      <div id="search-results" style="margin-bottom:var(--sp-4);max-height:200px;overflow-y:auto"></div>
      <div style="display:flex;gap:var(--sp-2)">
        <button class="btn-secondary" id="close-dialog" style="flex:1">Cancel</button>
        <button class="btn-primary" id="create-group-btn" style="flex:1;display:none">Create Group</button>
      </div>
    </div>
  `));

  document.body.appendChild(overlay);
  trapFocusInOverlay(overlay);

  let isGroup = false;
  const selectedMembers: { userId: string; displayName: string; username: string }[] = [];

  const modeDirectBtn = overlay.querySelector('#mode-direct') as HTMLButtonElement;
  const modeGroupBtn = overlay.querySelector('#mode-group') as HTMLButtonElement;
  const groupNameSection = overlay.querySelector('#group-name-section') as HTMLElement;
  const selectedMembersEl = overlay.querySelector('#selected-members') as HTMLElement;
  const createGroupBtn = overlay.querySelector('#create-group-btn') as HTMLButtonElement;

  modeDirectBtn.addEventListener('click', () => {
    isGroup = false;
    modeDirectBtn.style.opacity = '1';
    modeGroupBtn.style.opacity = '0.5';
    groupNameSection.style.display = 'none';
    createGroupBtn.style.display = 'none';
    selectedMembersEl.style.display = 'none';
    selectedMembers.length = 0;
    renderSelectedMembers();
  });

  modeGroupBtn.addEventListener('click', () => {
    isGroup = true;
    modeGroupBtn.style.opacity = '1';
    modeDirectBtn.style.opacity = '0.5';
    groupNameSection.style.display = 'block';
    createGroupBtn.style.display = 'block';
    selectedMembersEl.style.display = 'flex';
  });

  function renderSelectedMembers() {
    selectedMembersEl.replaceChildren(parseHTML(selectedMembers.map((m, i) => `
      <span style="background:var(--bg-tertiary);padding:2px 8px;border-radius:12px;font-size:var(--text-xs);display:flex;align-items:center;gap:4px">
        @${escapeHtml(m.username)}
        <span data-remove-idx="${i}" style="cursor:pointer;opacity:0.6">&times;</span>
      </span>
    `).join('')));
    selectedMembersEl.querySelectorAll('[data-remove-idx]').forEach(el => {
      el.addEventListener('click', () => {
        selectedMembers.splice(Number((el as HTMLElement).dataset.removeIdx), 0 + 1);
        renderSelectedMembers();
      });
    });
  }

  createGroupBtn.addEventListener('click', async () => {
    if (selectedMembers.length < 1) return;
    const groupName = (overlay.querySelector('#group-name-input') as HTMLInputElement).value.trim() || 'Group';
    const encMeta = await encryptProfileField(groupName);
    const convRes = await api.createConversation({
      type: 'group',
      member_ids: selectedMembers.map(m => m.userId),
      encrypted_meta: encMeta,
    });
    if (convRes.ok) {
      overlay.remove();
      const listRes = await api.getConversations();
      if (listRes.ok) {
        state.conversations = listRes.data.conversations || [];
        renderConversationsList();
        openConversation(convRes.data.conversation_id);
      }
    }
  });

  overlay.querySelector('#close-dialog')?.addEventListener('click', () => overlay.remove());
  overlay.addEventListener('click', (e) => {
    if (e.target === overlay) overlay.remove();
  });

  let searchTimeout: ReturnType<typeof setTimeout>;
  overlay.querySelector('#search-user-input')?.addEventListener('input', (e) => {
    clearTimeout(searchTimeout);
    const q = (e.target as HTMLInputElement).value.trim();
    if (q.length < 3) return;
    searchTimeout = setTimeout(async () => {
      const res = await api.searchUsers(q.replace(/^@/, ''));
      const results = document.getElementById('search-results');
      if (!results || !res.ok) return;

      const users = res.data.results || [];
      if (users.length === 0) {
        results.replaceChildren(parseHTML('<p style="font-size:var(--text-sm);color:var(--text-tertiary)">No users found.</p>'));
        return;
      }

      results.replaceChildren(parseHTML(users
        .map(
          (u) => `
        <div class="conversation-item" data-user-id="${u.userId}" data-display-name="${escapeHtml(u.displayName)}" data-username="${escapeHtml(u.username)}" style="cursor:pointer">
          <div class="avatar" style="width:36px;height:36px;font-size:var(--text-xs)">
            ${u.displayName.split(' ').map((w: string) => w[0]).join('').slice(0, 2).toUpperCase()}
          </div>
          <div class="conversation-info">
            <div class="conversation-name">${escapeHtml(u.displayName)}</div>
            <div class="conversation-preview">@${escapeHtml(u.username)}</div>
          </div>
        </div>
      `,
        )
        .join('')));

      results.querySelectorAll('.conversation-item').forEach((el) => {
        el.addEventListener('click', async () => {
          const uid = (el as HTMLElement).dataset.userId!;
          const displayName = (el as HTMLElement).dataset.displayName || '';
          const username = (el as HTMLElement).dataset.username || '';

          if (isGroup) {
            if (!selectedMembers.some(m => m.userId === uid)) {
              selectedMembers.push({ userId: uid, displayName, username });
              renderSelectedMembers();
            }
          } else {
            const convRes = await api.createConversation({
              type: 'direct',
              member_ids: [uid],
            });
            if (convRes.ok) {
              overlay.remove();
              const listRes = await api.getConversations();
              if (listRes.ok) {
                state.conversations = listRes.data.conversations || [];
                renderConversationsList();
                openConversation(convRes.data.conversation_id);
              }
            }
          }
        });
      });
    }, 300);
  });
}

// ── Disappearing Messages ──

// Persist per-conversation disappear timers across sessions
const disappearTimers = new Map<string, number>();
(() => {
  try {
    const saved = JSON.parse(localStorage.getItem('rocchat_disappear_timers') || '{}');
    for (const [k, v] of Object.entries(saved)) {
      if (typeof v === 'number') disappearTimers.set(k, v);
    }
  } catch { /* ignore */ }
})();
function saveDisappearTimers() {
  const obj: Record<string, number> = {};
  disappearTimers.forEach((v, k) => { if (v > 0) obj[k] = v; });
  localStorage.setItem('rocchat_disappear_timers', JSON.stringify(obj));
}

// Client-side cleanup: filter expired messages every 30s
setInterval(() => {
  const now = Math.floor(Date.now() / 1000);
  for (const [cid, msgs] of state.messages) {
    const before = msgs.length;
    const filtered = msgs.filter(m => !m.expires_at || m.expires_at > now);
    if (filtered.length < before) {
      state.messages.set(cid, filtered);
      if (state.activeConversationId === cid) renderMessages(filtered);
    }
  }
}, 30000);

// ── Donor Badge Feathers ──
const DONOR_FEATHERS: Record<string, { emoji: string; color: string; size: number }> = {
  coffee:   { emoji: '🪶', color: '#8B7355', size: 12 },
  feather:  { emoji: '🪶', color: '#d97706', size: 14 },
  wing:     { emoji: '🪶', color: '#fbbf24', size: 16 },
  mountain: { emoji: '🪶', color: '#f59e0b', size: 18 },
  patron:   { emoji: '🪶', color: '#40E0D0', size: 20 },
};

function renderDonorBadge(userId?: string): string {
  if (!userId) return '';
  const tier = localStorage.getItem(`rocchat_donor_${userId}`);
  if (!tier || !DONOR_FEATHERS[tier]) return '';
  const f = DONOR_FEATHERS[tier];
  return `<span class="donor-feather" style="position:absolute;bottom:-2px;right:-2px;font-size:${f.size}px;filter:drop-shadow(0 0 3px ${f.color})" title="${tier} supporter">${f.emoji}</span>`;
}

function renderTierBadge(accountTier?: string): string {
  if (accountTier === 'premium') {
    // Golden Roc Wings — pair of small gold wings wrapping bottom of avatar
    return `<span class="tier-badge premium-wings" style="position:absolute;bottom:-4px;left:50%;transform:translateX(-50%);font-size:14px;filter:drop-shadow(0 0 4px rgba(212,175,55,0.4));animation:wingPulse 3s ease-in-out infinite" title="Premium">\u{1F985}</span>`;
  }
  return '';
}

// ── Avatar Helper ──
function renderAvatar(name: string, avatarUrl?: string, userId?: string, size = 50, fontSize = 18, accountTier?: string): string {
  const initials = name.split(' ').map(w => w[0]).join('').slice(0, 2).toUpperCase();
  const badge = renderDonorBadge(userId);
  const tierBadge = renderTierBadge(accountTier);
  const borderStyle = accountTier === 'premium' ? 'border:2px solid #D4AF37;' : '';
  const isOnline = userId ? onlineUsers.has(userId) : false;
  const presenceDot = userId ? `<span class="presence-dot${isOnline ? ' online' : ''}" data-uid="${userId}"></span>` : '';
  if (avatarUrl && userId) {
    const path = avatarUrl.startsWith('/api/') ? avatarUrl : `/api${avatarUrl}`;
    const sep = path.includes('?') ? '&' : '?';
    return `<div class="avatar" style="position:relative;width:${size}px;height:${size}px;font-size:${fontSize}px;line-height:${size}px;overflow:visible;${borderStyle}"><img src="${path}${sep}uid=${encodeURIComponent(userId)}" alt="${escapeHtml(name)}" loading="lazy" decoding="async" style="width:100%;height:100%;object-fit:cover;border-radius:50%" data-fallback="${initials}" />${presenceDot}${badge}${tierBadge}</div>`;
  }
  return `<div class="avatar" style="position:relative;width:${size}px;height:${size}px;font-size:${fontSize}px;line-height:${size}px;overflow:visible;${borderStyle}">${initials}${presenceDot}${badge}${tierBadge}</div>`;
}

function showScheduleDialog(conversationId: string, input: HTMLTextAreaElement) {
  const overlay = document.createElement('div');
  overlay.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,0.5);z-index:50;display:flex;align-items:center;justify-content:center;padding:var(--sp-4)';

  // Default to 1 hour from now
  const now = new Date();
  now.setHours(now.getHours() + 1, 0, 0, 0);
  const defaultTime = now.toISOString().slice(0, 16);

  overlay.replaceChildren(parseHTML(`
    <div style="background:var(--bg-elevated);border-radius:var(--radius-xl);max-width:360px;width:100%;padding:var(--sp-5);box-shadow:var(--shadow-xl)">
      <h3 style="margin-bottom:var(--sp-3)">Schedule Message</h3>
      <p style="font-size:var(--text-sm);color:var(--text-secondary);margin-bottom:var(--sp-4)">Choose when to send this message:</p>
      <input type="datetime-local" id="schedule-time" class="form-input" style="width:100%;margin-bottom:var(--sp-4)" value="${defaultTime}" min="${new Date().toISOString().slice(0, 16)}" />
      <div style="display:flex;gap:var(--sp-2)">
        <button class="btn-secondary" id="schedule-cancel" style="flex:1">Cancel</button>
        <button class="btn-primary" id="schedule-confirm" style="flex:1">Schedule</button>
      </div>
    </div>
  `));

  overlay.querySelector('#schedule-cancel')?.addEventListener('click', () => overlay.remove());
  overlay.addEventListener('click', (e) => { if (e.target === overlay) overlay.remove(); });

  overlay.querySelector('#schedule-confirm')?.addEventListener('click', async () => {
    const timeInput = overlay.querySelector('#schedule-time') as HTMLInputElement;
    const scheduledDate = new Date(timeInput.value);
    const scheduledAt = Math.floor(scheduledDate.getTime() / 1000);

    if (scheduledAt <= Math.floor(Date.now() / 1000)) {
      showToast('Please select a future time', 'error');
      return;
    }

    const text = input.value.trim();
    // Encrypt the scheduled message before storing on server
    let encrypted: string;
    try {
      const encoder = new TextEncoder();
      const key = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, true, ['encrypt']);
      const iv = crypto.getRandomValues(new Uint8Array(12));
      const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, encoder.encode(text));
      const rawKey = await crypto.subtle.exportKey('raw', key);
      encrypted = JSON.stringify({
        ct: toBase64(new Uint8Array(ct)),
        iv: toBase64(iv),
        key: toBase64(new Uint8Array(rawKey)),
        type: 'scheduled'
      });
    } catch {
      encrypted = JSON.stringify({ text, type: 'scheduled' });
    }

    try {
      const res = await api.createScheduledMessage(conversationId, encrypted, scheduledAt);
      if (res.ok) {
        showToast(`Message scheduled for ${scheduledDate.toLocaleString()}`);
        input.value = '';
        input.dispatchEvent(new Event('input'));
        overlay.remove();
      } else {
        showToast('Failed to schedule message', 'error');
      }
    } catch { showToast('Failed to schedule message', 'error'); }
  });

  document.body.appendChild(overlay);
  trapFocusInOverlay(overlay);
}

function initSwipeActions(listEl: HTMLElement) {
  listEl.querySelectorAll('.swipe-container').forEach(container => {
    const item = container.querySelector('.conversation-item.swipeable') as HTMLElement;
    if (!item) return;

    let startX = 0;
    let currentX = 0;
    let swiping = false;
    const MAX_SWIPE = 156; // 3 actions * 52px each

    item.addEventListener('touchstart', (e) => {
      startX = e.touches[0].clientX;
      currentX = 0;
      swiping = true;
      item.style.transition = 'none';
    }, { passive: true });

    item.addEventListener('touchmove', (e) => {
      if (!swiping) return;
      const dx = e.touches[0].clientX - startX;
      // Only allow swiping left (negative)
      currentX = Math.max(-MAX_SWIPE, Math.min(0, dx));
      item.style.transform = `translateX(${currentX}px)`;
    }, { passive: true });

    item.addEventListener('touchend', () => {
      swiping = false;
      item.style.transition = 'transform 0.25s ease';
      if (currentX < -60) {
        // Snap open
        haptic(5);
        item.style.transform = `translateX(-${MAX_SWIPE}px)`;
        item.dataset.swiped = 'true';
      } else {
        // Snap closed
        item.style.transform = 'translateX(0)';
        item.dataset.swiped = '';
      }
    });

    // Close on tap elsewhere
    item.addEventListener('click', (ev) => {
      if (item.dataset.swiped === 'true') {
        ev.stopPropagation();
        ev.preventDefault();
        item.style.transition = 'transform 0.25s ease';
        item.style.transform = 'translateX(0)';
        item.dataset.swiped = '';
      }
    });

    // Action buttons
    const convId = (container as HTMLElement).dataset.convId!;
    container.querySelector('.swipe-delete')?.addEventListener('click', async () => {
      if (confirm('Delete this conversation?')) {
        await api.deleteConversation(convId);
        state.conversations = state.conversations.filter(c => c.id !== convId);
        if (state.activeConversationId === convId) state.activeConversationId = null;
        renderConversationsList();
      }
    });
    container.querySelector('.swipe-pin')?.addEventListener('click', async () => {
      item.style.transition = 'transform 0.25s ease';
      item.style.transform = 'translateX(0)';
      item.dataset.swiped = '';
      try {
        const res = await api.pinConversation(convId);
        const conv = state.conversations.find(c => c.id === convId);
        if (conv) conv.pinned = res.data?.pinned ?? false;
        renderConversationsList();
      } catch { showToast('Failed to pin', 'error'); }
    });
    container.querySelector('.swipe-mute')?.addEventListener('click', async () => {
      item.style.transition = 'transform 0.25s ease';
      item.style.transform = 'translateX(0)';
      item.dataset.swiped = '';
      // Show notification mode picker
      const overlay = document.createElement('div');
      overlay.className = 'view-once-modal';
      overlay.replaceChildren(parseHTML(`
        <div class="view-once-dialog" style="max-width:300px">
          <h3 style="margin:0 0 12px">Notification Mode</h3>
          ${['normal', 'quiet', 'focus', 'emergency', 'silent', 'scheduled'].map(m =>
            `<button class="btn-secondary notif-mode-btn" data-mode="${m}" style="width:100%;margin-bottom:8px;text-align:left;padding:10px 14px">
              <strong>${m.charAt(0).toUpperCase() + m.slice(1)}</strong>
              <span style="display:block;font-size:var(--text-xs);color:var(--text-tertiary)">${{
                normal: 'All notifications',
                quiet: 'Badge count only, no sound',
                focus: 'Only @mentions and replies',
                emergency: 'Calls ring, messages silent',
                silent: 'Nothing until you open app',
                scheduled: 'Only during configured hours',
              }[m]}</span>
            </button>`
          ).join('')}
          <button class="btn-secondary" id="notif-cancel" style="width:100%;margin-top:4px">Cancel</button>
        </div>
      `));
      document.body.appendChild(overlay);
      trapFocusInOverlay(overlay);
      overlay.querySelector('#notif-cancel')?.addEventListener('click', () => overlay.remove());
      overlay.addEventListener('click', (e) => { if (e.target === overlay) overlay.remove(); });
      overlay.querySelectorAll('.notif-mode-btn').forEach(btn => {
        btn.addEventListener('click', async () => {
          const mode = (btn as HTMLElement).dataset.mode!;
          await api.setNotificationMode(convId, mode);
          const conv = state.conversations.find(c => c.id === convId);
          if (conv) conv.muted = mode !== 'normal';
          showToast(`Notifications: ${mode}`, 'success');
          overlay.remove();
          renderConversationsList();
        });
      });
    });
    container.querySelector('.swipe-archive')?.addEventListener('click', async () => {
      const res = await api.archiveConversation(convId);
      const conv = state.conversations.find(c => c.id === convId);
      if (conv) conv.archived = res.data.archived;
      if (res.data.archived) {
        state.conversations = state.conversations.filter(c => c.id !== convId);
        if (state.activeConversationId === convId) state.activeConversationId = null;
      }
      showToast(res.data.archived ? 'Archived' : 'Unarchived', 'success');
      renderConversationsList();
    });
  });
}

function getOtherMember(conv: Conversation): Conversation['members'][0] | undefined {
  const userId = localStorage.getItem('rocchat_user_id') || '';
  return conv.members.find(m => m.user_id !== userId);
} // conversationId → seconds

function showDisappearingMenu(conversationId: string) {
  const currentTimer = disappearTimers.get(conversationId) || 0;
  const conv = state.conversations.find(c => c.id === conversationId) as Record<string, unknown> | undefined;
  const currentMediaExpiry = (conv?.media_expiry as number) || 0;
  const currentVoiceExpiry = (conv?.voice_expiry as number) || 0;
  const currentCallExpiry = (conv?.call_history_expiry as number) || 0;
  const currentBurnOnRead = !!(conv?.burn_on_read);

  const overlay = document.createElement('div');
  overlay.style.cssText = `
    position:fixed;inset:0;background:rgba(0,0,0,0.5);z-index:50;
    display:flex;align-items:center;justify-content:center;padding:var(--sp-4);
  `;

  const msgOptions = [
    { label: 'Off', value: 0 },
    { label: '5 minutes', value: 300 },
    { label: '1 hour', value: 3600 },
    { label: '6 hours', value: 21600 },
    { label: '12 hours', value: 43200 },
    { label: '24 hours', value: 86400 },
    { label: '7 days', value: 604800 },
    { label: '30 days', value: 2592000 },
  ];

  const mediaOptions = [
    { label: 'Off', value: 0 },
    { label: 'After viewed', value: -1 },
    { label: '1 hour', value: 3600 },
    { label: '24 hours', value: 86400 },
  ];

  const voiceOptions = [
    { label: 'Off', value: 0 },
    { label: 'After played', value: -1 },
    { label: '1 hour', value: 3600 },
  ];

  const callOptions = [
    { label: 'Off', value: 0 },
    { label: '24 hours', value: 86400 },
    { label: '7 days', value: 604800 },
  ];

  const renderOpts = (opts: {label:string;value:number}[], current: number, cls: string) =>
    opts.map(o => `<button class="btn-secondary ${cls} ${current === o.value ? 'active' : ''}" data-value="${o.value}" style="font-size:var(--text-xs);padding:4px 8px;${current === o.value ? 'border-color:var(--roc-gold);color:var(--roc-gold)' : ''}">${o.label}</button>`).join('');

  overlay.replaceChildren(parseHTML(`
    <div class="auth-card" style="max-width:380px;max-height:90vh;overflow-y:auto">
      <h2 style="font-size:var(--text-lg);margin-bottom:var(--sp-3)">Disappearing Settings</h2>

      <div style="margin-bottom:var(--sp-3)">
        <h3 style="font-size:var(--text-sm);color:var(--text-secondary);margin-bottom:var(--sp-1)">💬 Messages</h3>
        <div style="display:flex;flex-wrap:wrap;gap:var(--sp-1)">${renderOpts(msgOptions, currentTimer, 'disappear-msg')}</div>
      </div>

      <div style="margin-bottom:var(--sp-3)">
        <h3 style="font-size:var(--text-sm);color:var(--text-secondary);margin-bottom:var(--sp-1)">🖼️ Media</h3>
        <div style="display:flex;flex-wrap:wrap;gap:var(--sp-1)">${renderOpts(mediaOptions, currentMediaExpiry, 'disappear-media')}</div>
      </div>

      <div style="margin-bottom:var(--sp-3)">
        <h3 style="font-size:var(--text-sm);color:var(--text-secondary);margin-bottom:var(--sp-1)">🎤 Voice Notes</h3>
        <div style="display:flex;flex-wrap:wrap;gap:var(--sp-1)">${renderOpts(voiceOptions, currentVoiceExpiry, 'disappear-voice')}</div>
      </div>

      <div style="margin-bottom:var(--sp-3)">
        <h3 style="font-size:var(--text-sm);color:var(--text-secondary);margin-bottom:var(--sp-1)">📞 Call History</h3>
        <div style="display:flex;flex-wrap:wrap;gap:var(--sp-1)">${renderOpts(callOptions, currentCallExpiry, 'disappear-call')}</div>
      </div>

      <div style="margin-bottom:var(--sp-3);display:flex;align-items:center;gap:var(--sp-2)">
        <label style="font-size:var(--text-sm);color:var(--text-secondary)">🔥 Burn on Read</label>
        <input type="checkbox" id="burn-on-read-toggle" ${currentBurnOnRead ? 'checked' : ''} style="accent-color:var(--roc-gold)">
        <span style="font-size:var(--text-xs);color:var(--text-tertiary)">Delete from BOTH devices after read</span>
      </div>

      <button class="btn-secondary" id="close-disappear" style="width:100%">Done</button>
    </div>
  `));

  document.body.appendChild(overlay);
  trapFocusInOverlay(overlay);

  overlay.querySelector('#close-disappear')?.addEventListener('click', () => overlay.remove());
  overlay.addEventListener('click', (e) => { if (e.target === overlay) overlay.remove(); });

  // Message timer
  overlay.querySelectorAll('.disappear-msg').forEach(btn => {
    btn.addEventListener('click', () => {
      const value = parseInt((btn as HTMLElement).dataset.value || '0', 10);
      disappearTimers.set(conversationId, value);
      saveDisappearTimers();
      overlay.querySelectorAll('.disappear-msg').forEach(b => { (b as HTMLElement).style.borderColor = ''; (b as HTMLElement).style.color = ''; b.classList.remove('active'); });
      (btn as HTMLElement).style.borderColor = 'var(--roc-gold)'; (btn as HTMLElement).style.color = 'var(--roc-gold)'; btn.classList.add('active');
      const timerBtn = document.getElementById('btn-disappear');
      if (timerBtn) {
        timerBtn.style.color = value > 0 ? 'var(--turquoise)' : '';
      }
    });
  });

  // Media/voice/call timers + burn on read — save to backend
  const saveExtended = async (field: string, value: number | boolean) => {
    try { await api.put(`/messages/conversations/${conversationId}/disappearing`, { [field]: value }); } catch { /* ignore */ }
  };
  overlay.querySelectorAll('.disappear-media').forEach(btn => {
    btn.addEventListener('click', () => {
      const v = parseInt((btn as HTMLElement).dataset.value || '0', 10);
      overlay.querySelectorAll('.disappear-media').forEach(b => { (b as HTMLElement).style.borderColor = ''; (b as HTMLElement).style.color = ''; });
      (btn as HTMLElement).style.borderColor = 'var(--roc-gold)'; (btn as HTMLElement).style.color = 'var(--roc-gold)';
      saveExtended('media_expiry', v);
    });
  });
  overlay.querySelectorAll('.disappear-voice').forEach(btn => {
    btn.addEventListener('click', () => {
      const v = parseInt((btn as HTMLElement).dataset.value || '0', 10);
      overlay.querySelectorAll('.disappear-voice').forEach(b => { (b as HTMLElement).style.borderColor = ''; (b as HTMLElement).style.color = ''; });
      (btn as HTMLElement).style.borderColor = 'var(--roc-gold)'; (btn as HTMLElement).style.color = 'var(--roc-gold)';
      saveExtended('voice_expiry', v);
    });
  });
  overlay.querySelectorAll('.disappear-call').forEach(btn => {
    btn.addEventListener('click', () => {
      const v = parseInt((btn as HTMLElement).dataset.value || '0', 10);
      overlay.querySelectorAll('.disappear-call').forEach(b => { (b as HTMLElement).style.borderColor = ''; (b as HTMLElement).style.color = ''; });
      (btn as HTMLElement).style.borderColor = 'var(--roc-gold)'; (btn as HTMLElement).style.color = 'var(--roc-gold)';
      saveExtended('call_history_expiry', v);
    });
  });
  overlay.querySelector('#burn-on-read-toggle')?.addEventListener('change', (e) => {
    saveExtended('burn_on_read', (e.target as HTMLInputElement).checked);
  });
}

const CHAT_THEMES: { key: string; label: string; vars: Record<string, string> }[] = [
  { key: 'default', label: 'Default', vars: {} },
  { key: 'midnight-blue', label: 'Midnight Blue', vars: { '--bg-app': '#0a1628', '--bg-bubble-mine': 'rgba(26, 54, 93, 0.8)', '--bg-bubble-theirs': 'rgba(30, 41, 59, 0.9)' } },
  { key: 'forest-green', label: 'Forest Green', vars: { '--bg-app': '#0a1f0a', '--bg-bubble-mine': 'rgba(20, 83, 45, 0.8)', '--bg-bubble-theirs': 'rgba(26, 46, 26, 0.9)' } },
  { key: 'sunset-amber', label: 'Sunset Amber', vars: { '--bg-app': '#1a0f05', '--bg-bubble-mine': 'rgba(124, 45, 18, 0.8)', '--bg-bubble-theirs': 'rgba(41, 32, 24, 0.9)' } },
  { key: 'ocean-teal', label: 'Ocean Teal', vars: { '--bg-app': '#042f2e', '--bg-bubble-mine': 'rgba(19, 78, 74, 0.8)', '--bg-bubble-theirs': 'rgba(26, 47, 46, 0.9)' } },
  { key: 'rose-gold', label: 'Rose Gold', vars: { '--bg-app': '#1a0a10', '--bg-bubble-mine': 'rgba(131, 24, 67, 0.8)', '--bg-bubble-theirs': 'rgba(42, 21, 32, 0.9)' } },
  { key: 'lavender', label: 'Lavender', vars: { '--bg-app': '#0f0a1a', '--bg-bubble-mine': 'rgba(76, 29, 149, 0.8)', '--bg-bubble-theirs': 'rgba(30, 21, 48, 0.9)' } },
  { key: 'charcoal', label: 'Charcoal', vars: { '--bg-app': '#111111', '--bg-bubble-mine': 'rgba(51, 51, 51, 0.9)', '--bg-bubble-theirs': 'rgba(34, 34, 34, 0.9)' } },
];

function applyConversationTheme(theme: string | null) {
  const root = document.documentElement;
  ['--bg-app', '--bg-bubble-mine', '--bg-bubble-theirs'].forEach(p => root.style.removeProperty(p));
  if (!theme || theme === 'default') return;
  const t = CHAT_THEMES.find(ct => ct.key === theme);
  if (t) Object.entries(t.vars).forEach(([k, v]) => root.style.setProperty(k, v));
}

/**
 * Per-conversation notification override picker.
 * Backend route: POST /api/messages/conversations/:id/notification-mode
 * Modes (matches migration 0010): normal | quiet | focus | emergency | silent | scheduled
 */
function showNotificationModeMenu(conversationId: string, anchor: HTMLElement) {
  document.querySelector('.notif-mode-menu')?.remove();
  const conv = state.conversations.find(c => c.id === conversationId) as any;
  const current = (conv?.notification_mode as string) || 'normal';

  const modes: { value: string; label: string; hint: string; glyph: string }[] = [
    { value: 'normal',    label: 'Normal',          hint: 'Push + sound + badge',                   glyph: '🔔' },
    { value: 'quiet',     label: 'Quiet',           hint: 'Badge only, no sound or push',           glyph: '🔕' },
    { value: 'focus',     label: 'Focus',           hint: 'Push only when @mentioned',              glyph: '🎯' },
    { value: 'emergency', label: 'Emergency only',  hint: 'Push only for urgent / panic messages',  glyph: '🚨' },
    { value: 'silent',    label: 'Muted',           hint: 'Nothing — not even a badge',             glyph: '🤫' },
    { value: 'scheduled', label: 'Quiet hours',     hint: 'Mute 22:00 → 07:00 local',               glyph: '🌙' },
  ];

  const menu = document.createElement('div');
  menu.className = 'notif-mode-menu msg-context-menu';
  menu.setAttribute('role', 'menu');
  menu.style.cssText = 'min-width:260px';
  menu.replaceChildren(parseHTML(`
    <div style="padding:8px 12px;font-size:11px;letter-spacing:0.08em;color:var(--text-tertiary);text-transform:uppercase">Notifications</div>
    ${modes.map(m => `
      <button class="ctx-menu-item notif-mode-item" data-mode="${m.value}" role="menuitemradio" aria-checked="${current === m.value}" style="display:flex;align-items:flex-start;gap:10px;width:100%;text-align:left;padding:10px 12px;background:none;border:none;color:var(--text-primary);cursor:pointer">
        <span style="font-size:18px;line-height:1.1">${m.glyph}</span>
        <span style="display:flex;flex-direction:column;gap:2px;flex:1">
          <span style="font-weight:600;font-size:13px${current === m.value ? ';color:var(--roc-gold)' : ''}">${m.label}${current === m.value ? ' ✓' : ''}</span>
          <span style="font-size:11px;color:var(--text-tertiary)">${m.hint}</span>
        </span>
      </button>
    `).join('')}
  `));

  // Position below the anchor button.
  const rect = anchor.getBoundingClientRect();
  menu.style.position = 'fixed';
  menu.style.top = `${rect.bottom + 6}px`;
  menu.style.right = `${Math.max(8, window.innerWidth - rect.right)}px`;
  menu.style.zIndex = '60';
  document.body.appendChild(menu);

  const dismiss = (ev: Event) => {
    if (!menu.contains(ev.target as Node)) {
      menu.remove();
      document.removeEventListener('click', dismiss, true);
    }
  };
  setTimeout(() => document.addEventListener('click', dismiss, true), 0);

  menu.querySelectorAll('.notif-mode-item').forEach(btn => {
    btn.addEventListener('click', async () => {
      const mode = (btn as HTMLElement).dataset.mode || 'normal';
      menu.remove();
      try {
        await api.setNotificationMode(conversationId, mode);
        if (conv) (conv as any).notification_mode = mode;
        showToast(`Notifications: ${modes.find(m => m.value === mode)?.label}`, 'info');
      } catch {
        showToast('Could not update notifications', 'error');
      }
    });
  });
}

function showConversationThemePicker(conversationId: string) {
  const conv = state.conversations.find(c => c.id === conversationId);
  const currentTheme = conv?.chat_theme || 'default';

  const overlay = document.createElement('div');
  overlay.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,0.5);z-index:50;display:flex;align-items:center;justify-content:center;padding:var(--sp-4)';

  overlay.replaceChildren(parseHTML(`
    <div class="auth-card" style="max-width:320px">
      <h2 style="font-size:var(--text-lg);margin-bottom:var(--sp-2)">Chat Theme</h2>
      <p style="font-size:var(--text-sm);color:var(--text-tertiary);margin-bottom:var(--sp-4)">Choose a theme for this conversation.</p>
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:var(--sp-2)">
        ${CHAT_THEMES.map(t => `
          <button class="btn-secondary theme-option" data-theme="${t.key}"
                  style="padding:var(--sp-2);text-align:center;${currentTheme === t.key ? 'border-color:var(--roc-gold);color:var(--roc-gold)' : ''}">
            <div style="width:100%;height:24px;border-radius:var(--radius-sm);margin-bottom:4px;background:${t.vars['--bg-app'] || 'var(--bg-app)'}"></div>
            <span style="font-size:var(--text-xs)">${t.label}</span>
          </button>
        `).join('')}
      </div>
      <button class="btn-secondary" id="close-theme" style="width:100%;margin-top:var(--sp-3)">Cancel</button>
    </div>
  `));

  document.body.appendChild(overlay);
  trapFocusInOverlay(overlay);
  overlay.querySelector('#close-theme')?.addEventListener('click', () => overlay.remove());
  overlay.addEventListener('click', (e) => { if (e.target === overlay) overlay.remove(); });

  overlay.querySelectorAll('.theme-option').forEach(btn => {
    btn.addEventListener('click', async () => {
      const theme = (btn as HTMLElement).dataset.theme!;
      const themeValue = theme === 'default' ? null : theme;
      await api.setConversationTheme(conversationId, themeValue);
      if (conv) (conv as any).chat_theme = themeValue;
      applyConversationTheme(themeValue);
      showToast(`Theme: ${CHAT_THEMES.find(t => t.key === theme)?.label || 'Default'}`, 'success');
      overlay.remove();
    });
  });
}

async function showSafetyNumber(conv: Conversation) {
  const userId = localStorage.getItem('rocchat_user_id') || '';
  const myIdentityKey = localStorage.getItem('rocchat_identity_pub');
  const other = conv.members.find((m) => m.user_id !== userId);
  if (!myIdentityKey || !other) return;

  // Fetch the other user's identity key from their pre-key bundle
  let theirIdentityKey: string | undefined;
  try {
    const bundle = await api.getPreKeyBundle(other.user_id);
    const bundleData = bundle?.data as { identity_key?: string } | undefined;
    theirIdentityKey = bundleData?.identity_key;
  } catch { /* ignore */ }

  if (!theirIdentityKey) {
    alert('Cannot verify: recipient identity key not available.');
    return;
  }

  const safetyNumber = await generateSafetyNumber(
    fromBase64(myIdentityKey),
    fromBase64(theirIdentityKey),
  );

  const groups = safetyNumber.split(' ');
  const verifiedKey = `rocchat_verified_${other.user_id}`;
  const isVerified = localStorage.getItem(verifiedKey) === safetyNumber;
  const overlay = document.createElement('div');
  overlay.style.cssText = `
    position:fixed;inset:0;background:rgba(0,0,0,0.5);z-index:50;
    display:flex;align-items:center;justify-content:center;padding:var(--sp-4);
  `;

  overlay.replaceChildren(parseHTML(`
    <div class="auth-card" style="max-width:380px">
      <h2 style="font-size:var(--text-lg);margin-bottom:var(--sp-2)">
        <i data-lucide="shield-check" style="width:20px;height:20px;display:inline-block;vertical-align:text-bottom"></i>
        Safety Number
      </h2>
      <p style="font-size:var(--text-sm);color:var(--text-tertiary);margin-bottom:var(--sp-4)">
        Compare this number with <strong>${escapeHtml(other.display_name || other.username)}</strong> to verify end-to-end encryption.
      </p>
      <div class="safety-number-grid">
        ${groups.map((g) => `<span class="safety-num">${g}</span>`).join('')}
      </div>
      <p style="font-size:var(--text-xs);color:var(--text-tertiary);margin-top:var(--sp-3)">
        If both of you see the same number, your messages are secure.
      </p>
      <div style="display:flex;gap:var(--sp-2);margin-top:var(--sp-4)">
        <button class="btn-secondary" id="close-safety" style="flex:1">Close</button>
        <button class="btn-primary" id="copy-safety" style="flex:1">Copy</button>
        <button class="btn-primary" id="verify-safety" style="flex:1;background:var(--accent-secondary,#22c55e)">${isVerified ? '✅ Verified' : '🔒 Mark Verified'}</button>
      </div>
    </div>
  `));

  document.body.appendChild(overlay);
  trapFocusInOverlay(overlay);

  if (typeof (window as any).lucide !== 'undefined') {
    (window as any).lucide.createIcons({ attrs: {}, nameAttr: 'data-lucide' });
  }

  overlay.querySelector('#close-safety')?.addEventListener('click', () => overlay.remove());
  overlay.addEventListener('click', (e) => { if (e.target === overlay) overlay.remove(); });
  overlay.querySelector('#copy-safety')?.addEventListener('click', async () => {
    await navigator.clipboard.writeText(safetyNumber);
    const btn = overlay.querySelector('#copy-safety') as HTMLButtonElement;
    if (btn) { btn.textContent = 'Copied!'; setTimeout(() => { btn.textContent = 'Copy'; }, 1500); }
  });

  overlay.querySelector('#verify-safety')?.addEventListener('click', () => {
    const btn = overlay.querySelector('#verify-safety') as HTMLButtonElement;
    if (localStorage.getItem(verifiedKey) === safetyNumber) {
      localStorage.removeItem(verifiedKey);
      if (btn) btn.textContent = '🔒 Mark Verified';
    } else {
      localStorage.setItem(verifiedKey, safetyNumber);
      if (btn) btn.textContent = '✅ Verified';
    }
    updateSafetyBadge(conv);
  });
}

function updateSafetyBadge(conv: Conversation) {
  const userId = localStorage.getItem('rocchat_user_id') || '';
  const other = conv.members.find(m => m.user_id !== userId);
  const badge = document.getElementById('safety-badge');
  if (!badge || !other) return;
  const verifiedKey = `rocchat_verified_${other.user_id}`;
  badge.style.display = localStorage.getItem(verifiedKey) ? 'inline' : 'none';
}

// ── Identity key change warning ──
window.addEventListener('rocchat:identity-key-changed', ((e: CustomEvent) => {
  const { userId } = e.detail;
  showToast('⚠️ A contact\'s identity key changed — re-verify their safety number', 'error');
  // Show banner in active chat if it's this contact
  const banner = document.getElementById('key-change-banner');
  if (banner) { banner.style.display = 'flex'; banner.dataset.userId = userId; }
}) as EventListener);

// ── Helpers ──

/** Add focus trap + Esc-to-close to an overlay dialog */
function trapFocusInOverlay(overlay: HTMLElement) {
  const prev = document.activeElement as HTMLElement | null;
  const focusable = 'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])';
  overlay.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') { overlay.remove(); prev?.focus(); return; }
    if (e.key !== 'Tab') return;
    const els = Array.from(overlay.querySelectorAll<HTMLElement>(focusable));
    if (!els.length) return;
    const first = els[0], last = els[els.length - 1];
    if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
    else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
  });
  requestAnimationFrame(() => {
    const first = overlay.querySelector<HTMLElement>(focusable);
    first?.focus();
  });
}

function getConversationName(conv: Conversation, userId: string): string {
  if (conv.name) return conv.name;
  const others = conv.members.filter((m) => m.user_id !== userId);
  if (others.length > 0) return others.map((m) => m.display_name || m.username).join(', ');
  return 'Unknown';
}

function formatTime(iso: string): string {
  const d = new Date(iso);
  const now = new Date();
  const diff = now.getTime() - d.getTime();

  if (diff < 60_000) return 'now';
  if (diff < 3600_000) return `${Math.floor(diff / 60_000)}m`;
  if (diff < 86400_000) return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  if (diff < 604800_000) return d.toLocaleDateString([], { weekday: 'short' });
  return d.toLocaleDateString([], { month: 'short', day: 'numeric' });
}

function formatDateLabel(d: Date): string {
  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const msgDay = new Date(d.getFullYear(), d.getMonth(), d.getDate());
  const diff = today.getTime() - msgDay.getTime();
  if (diff === 0) return 'Today';
  if (diff === 86400_000) return 'Yesterday';
  if (diff < 604800_000) return d.toLocaleDateString([], { weekday: 'long' });
  return d.toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' });
}

function tryParseGif(text: string): { type: string; url: string; preview?: string; width?: number; height?: number } | null {
  try {
    const obj = JSON.parse(text);
    if (obj && obj.type === 'gif' && obj.url) return obj;
  } catch { /* not JSON */ }
  return null;
}

// ── Call initiation ──

async function startCall(conv: Conversation, callType: 'voice' | 'video') {
  const { startOutgoingCall } = await import('../calls/calls.js');
  const userId = localStorage.getItem('rocchat_user_id') || '';
  const recipient = conv.members.find((m) => m.user_id !== userId);
  if (!recipient || !state.ws) return;
  startOutgoingCall(conv.id, recipient.user_id, recipient.display_name || recipient.username, callType, state.ws);
}

async function startGroupCallFromChat(conv: Conversation) {
  const { startGroupCall } = await import('../calls/calls.js');
  if (!state.ws) return;
  const memberIds = conv.members.map((m) => m.user_id);
  startGroupCall(conv.id, 'voice', state.ws, memberIds);
}

// ── Voice & Video note recording ──
// Animated preview UX: user records, sees live waveform + timer, then previews
// and explicitly taps Send or Cancel. Auto-stops at 5 min.

interface RecordingState {
  kind: 'audio' | 'video';
  conversationId: string;
  stream: MediaStream;
  recorder: MediaRecorder;
  chunks: Blob[];
  startedAt: number;
  audioCtx?: AudioContext;
  analyser?: AnalyserNode;
  rafId?: number;
  timerId?: ReturnType<typeof setInterval>;
  autoStopId?: ReturnType<typeof setTimeout>;
  cancelled: boolean;
  overlay: HTMLElement;
  videoEl?: HTMLVideoElement;
}

let activeRecording: RecordingState | null = null;

function startVoiceRecording(conversationId: string) {
  if (activeRecording) return;
  navigator.mediaDevices.getUserMedia({ audio: true })
    .then((stream) => beginRecording('audio', conversationId, stream))
    .catch(() => showToast('Microphone access denied', 'error'));
}

function startVideoRecording(conversationId: string) {
  if (activeRecording) return;
  navigator.mediaDevices.getUserMedia({ audio: true, video: { width: 480, height: 480, facingMode: 'user' } })
    .then((stream) => beginRecording('video', conversationId, stream))
    .catch(() => showToast('Camera access denied', 'error'));
}

function beginRecording(kind: 'audio' | 'video', conversationId: string, stream: MediaStream) {
  const mime = kind === 'audio' ? 'audio/webm;codecs=opus' : 'video/webm;codecs=vp8,opus';
  let recorder: MediaRecorder;
  try { recorder = new MediaRecorder(stream, { mimeType: mime }); }
  catch { recorder = new MediaRecorder(stream); }

  const overlay = buildRecordingOverlay(kind);
  document.body.appendChild(overlay);
  trapFocusInOverlay(overlay);

  const rec: RecordingState = {
    kind, conversationId, stream, recorder, chunks: [],
    startedAt: Date.now(), cancelled: false, overlay,
  };
  activeRecording = rec;

  // Wire live preview
  if (kind === 'video') {
    const vid = overlay.querySelector<HTMLVideoElement>('.rocchat-rec-video')!;
    vid.srcObject = stream;
    vid.play().catch(() => {});
    rec.videoEl = vid;
  }

  // Waveform from audio track
  try {
    const audioCtx = new AudioContext();
    const src = audioCtx.createMediaStreamSource(stream);
    const analyser = audioCtx.createAnalyser();
    analyser.fftSize = 256;
    src.connect(analyser);
    rec.audioCtx = audioCtx;
    rec.analyser = analyser;
    const canvas = overlay.querySelector<HTMLCanvasElement>('.rocchat-rec-wave')!;
    drawWaveform(rec, canvas);
  } catch {}

  // Timer
  const timerEl = overlay.querySelector<HTMLElement>('.rocchat-rec-timer')!;
  rec.timerId = setInterval(() => {
    const secs = Math.floor((Date.now() - rec.startedAt) / 1000);
    timerEl.textContent = fmtDuration(secs);
  }, 250);

  // Auto-stop at 5 min
  rec.autoStopId = setTimeout(() => {
    if (rec.recorder.state === 'recording') rec.recorder.stop();
  }, 300000);

  recorder.ondataavailable = (e) => { if (e.data.size > 0) rec.chunks.push(e.data); };
  recorder.onstop = () => finishRecording(rec);

  recorder.start(250);

  // Wire controls
  overlay.querySelector('.rocchat-rec-cancel')?.addEventListener('click', () => {
    rec.cancelled = true;
    if (rec.recorder.state === 'recording') rec.recorder.stop();
  });
  overlay.querySelector('.rocchat-rec-send')?.addEventListener('click', () => {
    if (rec.recorder.state === 'recording') rec.recorder.stop();
    else finishRecording(rec);
  });
}

function buildRecordingOverlay(kind: 'audio' | 'video'): HTMLElement {
  injectRecordingStyles();
  const el = document.createElement('div');
  el.className = 'rocchat-rec-overlay';
  el.replaceChildren(parseHTML(`
    <div class="rocchat-rec-panel">
      <div class="rocchat-rec-header">
        <span class="rocchat-rec-dot"></span>
        <span class="rocchat-rec-label">${kind === 'audio' ? 'Recording voice…' : 'Recording video…'}</span>
        <span class="rocchat-rec-timer">0:00</span>
      </div>
      ${kind === 'video' ? '<video class="rocchat-rec-video" muted playsinline></video>' : ''}
      <canvas class="rocchat-rec-wave" width="560" height="64"></canvas>
      <div class="rocchat-rec-actions">
        <button class="rocchat-rec-cancel" title="Cancel">
          <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h18"/><path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6"/></svg>
        </button>
        <div class="rocchat-rec-spacer"></div>
        <button class="rocchat-rec-send" title="Send">
          <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m22 2-7 20-4-9-9-4Z"/><path d="M22 2 11 13"/></svg>
        </button>
      </div>
    </div>
  `));
  return el;
}

function injectRecordingStyles() {
  if (document.getElementById('rocchat-rec-styles')) return;
  const s = document.createElement('style');
  s.id = 'rocchat-rec-styles';
  s.textContent = `
    .rocchat-rec-overlay{position:fixed;inset:0;background:rgba(0,0,0,.55);display:flex;align-items:center;justify-content:center;z-index:9999;animation:rocRecFade .15s ease-out}
    .rocchat-rec-panel{background:var(--bg-elev,#fff);border-radius:20px;padding:20px;min-width:320px;max-width:620px;width:min(90vw,620px);box-shadow:0 20px 60px rgba(0,0,0,.35);display:flex;flex-direction:column;gap:14px}
    .rocchat-rec-header{display:flex;align-items:center;gap:10px;color:var(--text,#111)}
    .rocchat-rec-dot{width:10px;height:10px;background:#ef4444;border-radius:50%;animation:rocRecPulse 1s ease-in-out infinite}
    .rocchat-rec-label{flex:1;font-weight:600}
    .rocchat-rec-timer{font-family:var(--font-mono,monospace);color:var(--roc-gold,#c9a34b)}
    .rocchat-rec-video{width:100%;max-height:280px;border-radius:12px;background:#000;object-fit:cover;transform:scaleX(-1)}
    .rocchat-rec-wave{width:100%;height:56px;background:rgba(201,163,75,.06);border-radius:10px}
    .rocchat-rec-actions{display:flex;align-items:center;gap:8px}
    .rocchat-rec-spacer{flex:1}
    .rocchat-rec-cancel,.rocchat-rec-send{width:48px;height:48px;border-radius:50%;border:0;cursor:pointer;display:inline-flex;align-items:center;justify-content:center;transition:transform .1s ease}
    .rocchat-rec-cancel{background:rgba(239,68,68,.12);color:#ef4444}
    .rocchat-rec-cancel:hover{background:rgba(239,68,68,.22)}
    .rocchat-rec-send{background:var(--roc-gold,#c9a34b);color:#fff}
    .rocchat-rec-send:hover{transform:scale(1.06)}
    @keyframes rocRecPulse{0%,100%{transform:scale(1);opacity:1}50%{transform:scale(1.4);opacity:.6}}
    @keyframes rocRecFade{from{opacity:0}to{opacity:1}}
  `;
  document.head.appendChild(s);
}

function drawWaveform(rec: RecordingState, canvas: HTMLCanvasElement) {
  const ctx = canvas.getContext('2d');
  if (!ctx || !rec.analyser) return;
  const analyser = rec.analyser;
  const data = new Uint8Array(analyser.frequencyBinCount);
  const render = () => {
    if (!activeRecording || activeRecording !== rec) return;
    analyser.getByteTimeDomainData(data);
    const w = canvas.width, h = canvas.height;
    ctx.clearRect(0, 0, w, h);
    ctx.lineWidth = 2;
    ctx.strokeStyle = getCssVar('--roc-gold') || '#c9a34b';
    ctx.beginPath();
    const slice = w / data.length;
    for (let i = 0; i < data.length; i++) {
      const v = data[i] / 128.0;
      const y = (v * h) / 2;
      const x = i * slice;
      if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
    }
    ctx.stroke();
    rec.rafId = requestAnimationFrame(render);
  };
  rec.rafId = requestAnimationFrame(render);
}

function getCssVar(name: string): string {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}

function fmtDuration(secs: number): string {
  const m = Math.floor(secs / 60);
  const s = secs % 60;
  return `${m}:${s.toString().padStart(2, '0')}`;
}

async function finishRecording(rec: RecordingState) {
  if (activeRecording !== rec) return;
  activeRecording = null;
  if (rec.rafId) cancelAnimationFrame(rec.rafId);
  if (rec.timerId) clearInterval(rec.timerId);
  if (rec.autoStopId) clearTimeout(rec.autoStopId);
  try { rec.audioCtx?.close(); } catch {}
  rec.stream.getTracks().forEach((t) => t.stop());
  rec.overlay.remove();

  if (rec.cancelled) return;
  const blob = new Blob(rec.chunks, { type: rec.kind === 'audio' ? 'audio/webm;codecs=opus' : 'video/webm;codecs=vp8,opus' });
  if (blob.size < 100) return;
  const duration = Math.round((Date.now() - rec.startedAt) / 1000);

  await uploadAndSendMediaNote(rec.conversationId, blob, rec.kind, duration);
}

async function uploadAndSendMediaNote(conversationId: string, blob: Blob, kind: 'audio' | 'video', duration: number) {
  const userId = localStorage.getItem('rocchat_user_id') || '';
  const conv = state.conversations.find((c) => c.id === conversationId);
  const recipientUserId = conv?.members.find((m) => m.user_id !== userId)?.user_id;
  try {
    const plainBytes = new Uint8Array(await blob.arrayBuffer());
    const fileKey = randomBytes(32);
    const fileIv = randomBytes(12);
    const fileHash = await cryptoSha256(plainBytes);

    const cryptoKey = await crypto.subtle.importKey('raw', fileKey.buffer as ArrayBuffer, 'AES-GCM', false, ['encrypt']);
    const encrypted = await crypto.subtle.encrypt(
      { name: 'AES-GCM', iv: fileIv.buffer as ArrayBuffer, tagLength: 128 },
      cryptoKey, plainBytes,
    );

    const token = api.getToken();
    const ext = kind === 'audio' ? 'webm' : 'webm';
    const filename = kind === 'audio' ? `voice_note.${ext}` : `video_note.${ext}`;
    const mime = kind === 'audio' ? 'audio/webm' : 'video/webm';
    const res = await fetch('/api/media/upload', {
      method: 'POST',
      headers: {
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        'Content-Type': 'application/octet-stream',
        'x-conversation-id': conversationId,
        'x-encrypted-filename': filename,
        'x-encrypted-mimetype': mime,
      },
      body: new Uint8Array(encrypted),
    });
    if (!res.ok) { showToast('Failed to upload', 'error'); return; }
    const data = await res.json() as { mediaId: string };
    const msgType = kind === 'audio' ? 'voice_note' : 'video_note';
    const payload = JSON.stringify({
      type: msgType,
      blobId: data.mediaId,
      fileKey: toBase64(fileKey),
      fileIv: toBase64(fileIv),
      fileHash: toBase64(fileHash),
      filename, mime, size: blob.size, duration,
    });

    let sendPayload: Parameters<typeof api.sendMessage>[0] | null = null;
    if (recipientUserId) {
      const enc = await encryptMessage(conversationId, recipientUserId, payload);
      const encAny = enc as unknown as Record<string, unknown>;
      const headerObj = encAny.x3dh ? { ...enc.header, x3dh: encAny.x3dh } : enc.header;
      sendPayload = {
        conversation_id: conversationId, ciphertext: enc.ciphertext, iv: enc.iv,
        ratchet_header: JSON.stringify(headerObj), message_type: msgType,
      };
    } else if (conv?.type === 'group' && conv.members.length > 2) {
      const gEnc = await groupEncrypt(conversationId, conv.members, payload);
      sendPayload = {
        conversation_id: conversationId, ciphertext: gEnc.ciphertext, iv: gEnc.iv,
        ratchet_header: gEnc.ratchet_header, message_type: msgType,
      };
    }
    if (sendPayload) {
      const sendRes = await api.sendMessage(sendPayload);
      const mid = (sendRes as { ok: boolean; data?: { message_id?: string } }).data?.message_id;
      if (mid) cachePlaintext(mid, payload);
    }
  } catch {
    showToast('Failed to send', 'error');
  }
}

// ── File message helpers ──

interface ParsedFileMessage {
  type: string;
  blobId: string;
  fileKey?: string;
  fileIv?: string;
  fileHash?: string;
  filename: string;
  mime: string;
  size: number;
  duration?: number;
  caption?: string;
  viewOnce?: boolean;
}

function tryParseFileMessage(text: string): ParsedFileMessage | null {
  try {
    const obj = JSON.parse(text) as Record<string, unknown>;
    if (!obj) return null;

    const blobId = String(obj.blobId || obj.blob_id || obj.mediaId || obj.media_id || '');
    const filename = String(obj.filename || obj.file_name || '');
    if (!blobId || !filename) return null;

    const normalized: ParsedFileMessage = {
      type: String(obj.type || 'file'),
      blobId,
      fileKey: obj.fileKey ? String(obj.fileKey) : (obj.file_key ? String(obj.file_key) : undefined),
      fileIv: obj.fileIv ? String(obj.fileIv) : (obj.file_iv ? String(obj.file_iv) : undefined),
      fileHash: obj.fileHash ? String(obj.fileHash) : (obj.file_hash ? String(obj.file_hash) : undefined),
      filename,
      mime: String(obj.mime || obj.mime_type || 'application/octet-stream'),
      size: Number(obj.size || 0),
      duration: obj.duration ? Number(obj.duration) : undefined,
      caption: obj.caption ? String(obj.caption) : undefined,
      viewOnce: Boolean(obj.viewOnce ?? obj.view_once ?? false),
    };
    return normalized;
  } catch { /* not a file message */ }
  return null;
}

function renderFileMessage(bubble: Element, fileMsg: ParsedFileMessage, conversationId: string) {
  const textEl = bubble.querySelector('.message-text');
  if (!textEl) return;

  // View-once media: show blurred placeholder with reveal-on-click
  if (fileMsg.viewOnce) {
    const msgRow = bubble.closest('.message-row');
    const msgId = msgRow?.getAttribute('data-msg-id') || fileMsg.blobId;
    const viewedKey = `rocchat_viewed_${msgId}`;
    const alreadyViewed = localStorage.getItem(viewedKey);

    if (alreadyViewed) {
      const opened = document.createElement('div');
      opened.className = 'view-once-opened';
      opened.replaceChildren(parseHTML(`<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="var(--text-tertiary)" stroke-width="2"><circle cx="12" cy="12" r="3"/><path d="M2 12s3-7 10-7 10 7 10 7-3 7-10 7S2 12 2 12z"/></svg><span>Opened</span>`));
      textEl.replaceWith(opened);
      return;
    }

    const wrapper = document.createElement('div');
    wrapper.className = 'view-once-wrapper';
    wrapper.replaceChildren(parseHTML(`
      <div class="view-once-overlay">
        <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="var(--roc-gold)" stroke-width="2"><circle cx="12" cy="12" r="3"/><path d="M2 12s3-7 10-7 10 7 10 7-3 7-10 7S2 12 2 12z"/></svg>
        <span>View once</span>
      </div>
    `));
    wrapper.addEventListener('click', async () => {
      try {
        const blob = await fetchAndDecryptMedia(fileMsg, conversationId);
        const url = URL.createObjectURL(blob);
        localStorage.setItem(viewedKey, '1');
        // Show in a modal overlay that auto-closes
        const modal = document.createElement('div');
        modal.className = 'view-once-modal';
        const isImg = fileMsg.mime.startsWith('image/');
        modal.replaceChildren(parseHTML(`
          <div class="view-once-modal-content">
            ${isImg
              ? `<img src="${url}" decoding="async" style="max-width:90vw;max-height:80vh;border-radius:12px" />`
              : `<video src="${url}" autoplay controls style="max-width:90vw;max-height:80vh;border-radius:12px"></video>`
            }
            <div class="view-once-timer">This media will disappear when closed</div>
          </div>
        `));
        modal.addEventListener('click', (e) => {
          if (e.target === modal || (e.target as HTMLElement).closest('.view-once-timer')) {
            URL.revokeObjectURL(url);
            modal.remove();
            const opened = document.createElement('div');
            opened.className = 'view-once-opened';
            opened.replaceChildren(parseHTML(`<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="var(--text-tertiary)" stroke-width="2"><circle cx="12" cy="12" r="3"/><path d="M2 12s3-7 10-7 10 7 10 7-3 7-10 7S2 12 2 12z"/></svg><span>Opened</span>`));
            wrapper.replaceWith(opened);
          }
        });
        document.body.appendChild(modal);
      } catch {
        wrapper.querySelector('.view-once-overlay span')!.textContent = 'Failed to load';
      }
    }, { once: true });
    textEl.replaceWith(wrapper);
    return;
  }

  const isImage = fileMsg.type === 'image' || fileMsg.mime.startsWith('image/');
  const isVideo = fileMsg.type === 'video' || fileMsg.type === 'video_note' || fileMsg.mime.startsWith('video/');
  const isAudio = fileMsg.type === 'voice_note' || fileMsg.mime.startsWith('audio/');

  if (isImage && fileMsg.fileKey) {
    const img = document.createElement('img');
    img.alt = fileMsg.filename;
    img.className = 'media-message';
    img.style.cssText = 'max-width:280px;max-height:300px;border-radius:12px;cursor:pointer;display:block';
    img.src = 'data:image/gif;base64,R0lGODlhAQABAIAAAMLCwgAAACH5BAAAAAAALAAAAAABAAEAAAICRAEAOw==';
    textEl.replaceWith(img);
    decryptAndDisplayMedia(img, fileMsg, conversationId, 'img');
  } else if (isVideo && fileMsg.fileKey) {
    const video = document.createElement('video');
    video.controls = true;
    video.className = 'media-message';
    video.style.cssText = 'max-width:280px;max-height:300px;border-radius:12px;display:block';
    textEl.replaceWith(video);
    decryptAndDisplayMedia(video, fileMsg, conversationId, 'video');
  } else if (isAudio && fileMsg.fileKey) {
    const audio = document.createElement('audio');
    audio.controls = true;
    audio.style.cssText = 'width:240px';
    textEl.replaceWith(audio);
    decryptAndDisplayMedia(audio, fileMsg, conversationId, 'audio');
  } else {
    const sizeStr = fileMsg.size < 1024 ? `${fileMsg.size} B`
      : fileMsg.size < 1048576 ? `${(fileMsg.size / 1024).toFixed(1)} KB`
      : `${(fileMsg.size / 1048576).toFixed(1)} MB`;
    const link = document.createElement('a');
    link.href = '#';
    link.textContent = `📎 ${fileMsg.filename} (${sizeStr})`;
    link.style.cssText = 'color:var(--accent);text-decoration:underline;cursor:pointer';
    link.addEventListener('click', async (e) => {
      e.preventDefault();
      link.textContent = '⏳ Downloading...';
      try {
        const blob = await fetchAndDecryptMedia(fileMsg, conversationId);
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = fileMsg.filename;
        a.click();
        URL.revokeObjectURL(url);
        link.textContent = `📎 ${fileMsg.filename} (${sizeStr})`;
      } catch {
        link.textContent = '⚠️ Download failed';
      }
    });
    textEl.replaceWith(link);
  }
}

async function fetchAndDecryptMedia(fileMsg: ParsedFileMessage, conversationId: string): Promise<Blob> {
  const token = api.getToken();
  const res = await fetch(`/api/media/${fileMsg.blobId}?cid=${conversationId}`, {
    headers: token ? { Authorization: `Bearer ${token}` } : {},
  });
  if (!res.ok) throw new Error('Failed to fetch media');
  const encryptedData = new Uint8Array(await res.arrayBuffer());

  if (fileMsg.fileKey && fileMsg.fileIv) {
    const key = fromBase64(fileMsg.fileKey);
    const iv = fromBase64(fileMsg.fileIv);
    const cryptoKey = await crypto.subtle.importKey('raw', key.buffer as ArrayBuffer, 'AES-GCM', false, ['decrypt']);
    const decrypted = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: iv.buffer as ArrayBuffer, tagLength: 128 },
      cryptoKey,
      encryptedData,
    );

    if (fileMsg.fileHash) {
      const hash = await cryptoSha256(new Uint8Array(decrypted));
      const expectedHash = fromBase64(fileMsg.fileHash);
      if (hash.length !== expectedHash.length || !hash.every((b, i) => b === expectedHash[i])) {
        throw new Error('File integrity check failed');
      }
    }

    return new Blob([decrypted], { type: fileMsg.mime });
  }

  return new Blob([encryptedData], { type: fileMsg.mime });
}

async function decryptAndDisplayMedia(
  el: HTMLImageElement | HTMLVideoElement | HTMLAudioElement,
  fileMsg: ParsedFileMessage,
  conversationId: string,
  kind: 'img' | 'video' | 'audio',
) {
  try {
    const blob = await fetchAndDecryptMedia(fileMsg, conversationId);
    const url = URL.createObjectURL(blob);
    if (kind === 'img') {
      (el as HTMLImageElement).src = url;
      el.addEventListener('click', () => window.open(url, '_blank'));
    } else {
      (el as HTMLVideoElement | HTMLAudioElement).src = url;
    }
  } catch (err) {
    const span = document.createElement('span');
    const reason = err instanceof Error ? err.message : '';
    if (reason.includes('integrity')) {
      span.textContent = `⚠️ Integrity check failed for ${fileMsg.filename}`;
      showToast('File integrity check failed', 'error');
    } else {
      span.textContent = `⚠️ Failed to load ${fileMsg.filename}`;
    }
    span.style.color = 'var(--text-tertiary)';
    el.replaceWith(span);
  }
}

function sniffMimeFromBytes(fileName: string, bytes: Uint8Array, fallback: string): string {
  // JPEG
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'image/jpeg';
  // PNG
  if (bytes.length >= 8 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) return 'image/png';
  // GIF
  if (bytes.length >= 6) {
    const sig = String.fromCharCode(...bytes.slice(0, 6));
    if (sig === 'GIF87a' || sig === 'GIF89a') return 'image/gif';
  }
  // WebP (RIFF....WEBP)
  if (bytes.length >= 12 &&
      String.fromCharCode(...bytes.slice(0, 4)) === 'RIFF' &&
      String.fromCharCode(...bytes.slice(8, 12)) === 'WEBP') return 'image/webp';
  // MP4 / MOV family (ftyp)
  if (bytes.length >= 12 && String.fromCharCode(...bytes.slice(4, 8)) === 'ftyp') {
    const brand = String.fromCharCode(...bytes.slice(8, 12)).toLowerCase();
    if (brand.includes('mp4')) return 'video/mp4';
    if (brand.includes('qt')) return 'video/quicktime';
  }
  // WebM / Matroska
  if (bytes.length >= 4 && bytes[0] === 0x1a && bytes[1] === 0x45 && bytes[2] === 0xdf && bytes[3] === 0xa3) {
    if (fileName.toLowerCase().endsWith('.webm')) return 'video/webm';
    return fallback || 'video/webm';
  }
  // MP3 ID3
  if (bytes.length >= 3 && bytes[0] === 0x49 && bytes[1] === 0x44 && bytes[2] === 0x33) return 'audio/mpeg';
  // WAV (RIFF....WAVE)
  if (bytes.length >= 12 &&
      String.fromCharCode(...bytes.slice(0, 4)) === 'RIFF' &&
      String.fromCharCode(...bytes.slice(8, 12)) === 'WAVE') return 'audio/wav';

  // Extension fallback if magic bytes unknown.
  const lower = fileName.toLowerCase();
  if (lower.endsWith('.jpg') || lower.endsWith('.jpeg')) return 'image/jpeg';
  if (lower.endsWith('.png')) return 'image/png';
  if (lower.endsWith('.gif')) return 'image/gif';
  if (lower.endsWith('.webp')) return 'image/webp';
  if (lower.endsWith('.mp4')) return 'video/mp4';
  if (lower.endsWith('.mov')) return 'video/quicktime';
  if (lower.endsWith('.webm')) return 'video/webm';
  if (lower.endsWith('.mp3')) return 'audio/mpeg';
  if (lower.endsWith('.wav')) return 'audio/wav';
  if (lower.endsWith('.m4a')) return 'audio/mp4';
  if (lower.endsWith('.pdf')) return 'application/pdf';
  if (lower.endsWith('.txt')) return 'text/plain';
  if (lower.endsWith('.zip')) return 'application/zip';
  return fallback || 'application/octet-stream';
}

// ── File upload ──

function showFileUpload(conversationId: string, initialFile?: File) {
  const input = document.createElement('input');
  input.type = 'file';
  input.accept = 'image/*,video/*,audio/*,.pdf,.doc,.docx,.txt,.zip';
  input.style.display = 'none';
  input.addEventListener('change', async () => {
    const file = initialFile || input.files?.[0];
    if (!file) return;
    input.remove();

    // For media files, offer view-once option
    let viewOnce = false;
    const isMedia = file.type.startsWith('image/') || file.type.startsWith('video/');
    if (isMedia) {
      viewOnce = await new Promise<boolean>((resolve) => {
        const dialog = document.createElement('div');
        dialog.className = 'view-once-modal';
        dialog.replaceChildren(parseHTML(`
          <div class="view-once-dialog">
            <h3 style="margin:0 0 8px">Send ${file.name}</h3>
            <label style="display:flex;align-items:center;gap:8px;cursor:pointer;margin:12px 0">
              <input type="checkbox" id="view-once-check" style="accent-color:var(--roc-gold);width:18px;height:18px" />
              <span>View once — disappears after opened</span>
            </label>
            <div style="display:flex;gap:8px;justify-content:flex-end;margin-top:16px">
              <button class="btn-secondary" id="vo-cancel" style="padding:6px 16px">Cancel</button>
              <button class="btn" id="vo-send" style="padding:6px 16px;background:var(--roc-gold);color:#fff;border:none;border-radius:8px;cursor:pointer">Send</button>
            </div>
          </div>
        `));
        document.body.appendChild(dialog);
        dialog.querySelector('#vo-cancel')?.addEventListener('click', () => { dialog.remove(); resolve(false); });
        dialog.querySelector('#vo-send')?.addEventListener('click', () => {
          const checked = (dialog.querySelector('#view-once-check') as HTMLInputElement)?.checked || false;
          dialog.remove();
          resolve(checked);
        });
        dialog.addEventListener('click', (e) => { if (e.target === dialog) { dialog.remove(); resolve(false); } });
      });
      // If dialog was cancelled via clicking Cancel, check if we should abort
      // Actually the flow continues regardless — viewOnce is just true/false
    }

    // Show upload progress
    const area = document.getElementById('messages-area');
    const userId = localStorage.getItem('rocchat_user_id') || '';
    const progressDiv = document.createElement('div');
    progressDiv.className = 'message-row mine';
    const optimisticId = `upload-${Date.now()}-${Math.random().toString(16).slice(2)}`;
    progressDiv.replaceChildren(parseHTML(`
      <div class="message-bubble" data-upload-id="${optimisticId}">
        <div class="message-text" style="color:var(--text-tertiary)">
          📎 Preparing ${escapeHtml(file.name)}...
        </div>
        <div style="height:4px;background:var(--bg-secondary);border-radius:999px;margin-top:8px;overflow:hidden">
          <div class="upload-progress" style="height:100%;width:8%;background:var(--accent);transition:width .2s ease"></div>
        </div>
        <div style="display:flex;gap:6px;justify-content:flex-end;margin-top:8px">
          <button class="btn btn-outline upload-cancel" style="font-size:11px;padding:4px 10px">Cancel</button>
        </div>
      </div>
    `));
    area?.appendChild(progressDiv);
    area && (area.scrollTop = area.scrollHeight);
    const progressBar = progressDiv.querySelector('.upload-progress') as HTMLElement | null;
    const statusEl = progressDiv.querySelector('.message-text') as HTMLElement | null;
    const cancelBtn = progressDiv.querySelector('.upload-cancel') as HTMLButtonElement | null;
    const abort = new AbortController();
    let cancelled = false;
    cancelBtn?.addEventListener('click', () => {
      cancelled = true;
      abort.abort();
      progressDiv.remove();
    });

    try {
      // Read file bytes
      const plainBytes = new Uint8Array(await file.arrayBuffer());
      const sniffedMime = sniffMimeFromBytes(file.name, plainBytes, file.type || 'application/octet-stream');
      if (progressBar) progressBar.style.width = '22%';

      // Generate random file key (256-bit) and compute hash
      const fileKey = randomBytes(32);
      const fileIv = randomBytes(12);
      const fileHash = await cryptoSha256(plainBytes);
      if (progressBar) progressBar.style.width = '34%';

      // Encrypt file with AES-256-GCM
      const cryptoKey = await crypto.subtle.importKey('raw', fileKey.buffer as ArrayBuffer, 'AES-GCM', false, ['encrypt']);
      const encrypted = await crypto.subtle.encrypt(
        { name: 'AES-GCM', iv: fileIv.buffer as ArrayBuffer, tagLength: 128 },
        cryptoKey,
        plainBytes,
      );
      if (progressBar) progressBar.style.width = '56%';

      if (statusEl) statusEl.textContent = `📎 Uploading ${file.name}...`;

      const token = api.getToken();
      const res = await fetch('/api/media/upload', {
        method: 'POST',
        signal: abort.signal,
        headers: {
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
          'Content-Type': 'application/octet-stream',
          'x-conversation-id': conversationId,
          'x-encrypted-filename': await encryptProfileField(file.name),
          'x-encrypted-mimetype': await encryptProfileField(sniffedMime),
        },
        body: new Uint8Array(encrypted),
      });
      if (progressBar) progressBar.style.width = '78%';

      if (res.ok) {
        const data = await res.json() as { mediaId: string };
        // Send file message with encryption keys via Double Ratchet
        const conv = state.conversations.find((c) => c.id === conversationId);
        const recipientUserId = conv?.members.find((m) => m.user_id !== userId)?.user_id;

        const msgType = sniffedMime.startsWith('image/') ? 'image'
          : sniffedMime.startsWith('video/') ? 'video'
          : sniffedMime.startsWith('audio/') ? 'voice_note'
          : 'file';

        const fileMsgObj: Record<string, unknown> = {
          type: msgType,
          blobId: data.mediaId,
          fileKey: toBase64(fileKey),
          fileIv: toBase64(fileIv),
          fileHash: toBase64(fileHash),
          filename: file.name,
          mime: sniffedMime,
          size: file.size,
        };
        if (viewOnce) fileMsgObj.viewOnce = true;
        const fileMsg = JSON.stringify(fileMsgObj);

        if (recipientUserId) {
          const encryptedMsg = await encryptMessage(conversationId, recipientUserId, fileMsg);
          await api.sendMessage({
            conversation_id: conversationId,
            ciphertext: encryptedMsg.ciphertext,
            iv: encryptedMsg.iv,
            tag: encryptedMsg.tag,
            ratchet_header: JSON.stringify({ ...encryptedMsg.header, tag: encryptedMsg.tag }),
            message_type: msgType,
          });
        } else if (conv?.type === 'group' && conv.members.length > 2) {
          const groupEnc = await groupEncrypt(conversationId, conv.members, fileMsg);
          await api.sendMessage({
            conversation_id: conversationId,
            ciphertext: groupEnc.ciphertext,
            iv: groupEnc.iv,
            ratchet_header: groupEnc.ratchet_header,
            message_type: msgType,
          });
        }

        if (progressBar) progressBar.style.width = '100%';
        if (statusEl) statusEl.textContent = `📎 ${file.name}`;
        cancelBtn?.remove();
      } else {
        const errText = `⚠️ Upload failed (${res.status})`;
        if (statusEl) statusEl.textContent = errText;
        if (!cancelled) {
          const retry = document.createElement('button');
          retry.className = 'btn btn-outline upload-retry';
          retry.textContent = 'Retry';
          retry.style.cssText = 'font-size:11px;padding:4px 10px';
          retry.addEventListener('click', () => {
            progressDiv.remove();
            showFileUpload(conversationId, file);
          });
          cancelBtn?.replaceWith(retry);
        }
      }
    } catch {
      if (cancelled) return;
      if (statusEl) statusEl.textContent = '⚠️ Upload failed';
      const retry = document.createElement('button');
      retry.className = 'btn btn-outline upload-retry';
      retry.textContent = 'Retry';
      retry.style.cssText = 'font-size:11px;padding:4px 10px';
      retry.addEventListener('click', () => {
        progressDiv.remove();
        showFileUpload(conversationId, file);
      });
      cancelBtn?.replaceWith(retry);
    }
  });
  document.body.appendChild(input);
  if (!initialFile) input.click();
  else input.dispatchEvent(new Event('change'));
}

// ── In-chat message search ──

function toggleMessageSearch() {
  const existing = document.getElementById('message-search-bar');
  if (existing) {
    existing.remove();
    clearSearchHighlights();
    return;
  }

  const chatHeader = document.querySelector('.chat-header');
  if (!chatHeader) return;

  const bar = document.createElement('div');
  bar.id = 'message-search-bar';
  bar.style.cssText = `
    display:flex;align-items:center;gap:8px;padding:8px 16px;
    background:var(--bg-secondary);border-bottom:1px solid var(--border);
  `;
  bar.replaceChildren(parseHTML(`
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="var(--text-tertiary)" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="11" r="8"/><path d="m21 21-4.3-4.3"/></svg>
    <input type="text" id="msg-search-input" placeholder="Search in conversation..."
      style="flex:1;background:var(--bg-primary);border:1px solid var(--border);border-radius:8px;padding:6px 12px;font-size:13px;color:var(--text-primary);outline:none" />
    <span id="msg-search-count" style="font-size:12px;color:var(--text-tertiary);min-width:40px;text-align:center"></span>
    <button id="msg-search-prev" class="icon-btn" style="padding:4px" title="Previous">
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="m18 15-6-6-6 6"/></svg>
    </button>
    <button id="msg-search-next" class="icon-btn" style="padding:4px" title="Next">
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="m6 9 6 6 6-6"/></svg>
    </button>
    <button id="msg-search-close" class="icon-btn" style="padding:4px" title="Close">
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M18 6 6 18"/><path d="m6 6 12 12"/></svg>
    </button>
  `));

  chatHeader.after(bar);
  const input = bar.querySelector('#msg-search-input') as HTMLInputElement;
  input.focus();

  let matchIndices: number[] = [];
  let currentMatch = -1;

  let debounce: ReturnType<typeof setTimeout>;
  input.addEventListener('input', () => {
    clearTimeout(debounce);
    debounce = setTimeout(() => {
      const q = input.value.trim().toLowerCase();
      matchIndices = searchMessages(q);
      currentMatch = matchIndices.length > 0 ? 0 : -1;
      updateSearchUI();
      if (currentMatch >= 0) scrollToMatch(matchIndices[currentMatch]);
    }, 200);
  });

  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      if (e.shiftKey) navigateMatch(-1);
      else navigateMatch(1);
    }
    if (e.key === 'Escape') {
      bar.remove();
      clearSearchHighlights();
    }
  });

  bar.querySelector('#msg-search-prev')?.addEventListener('click', () => navigateMatch(-1));
  bar.querySelector('#msg-search-next')?.addEventListener('click', () => navigateMatch(1));
  bar.querySelector('#msg-search-close')?.addEventListener('click', () => {
    bar.remove();
    clearSearchHighlights();
  });

  function navigateMatch(dir: number) {
    if (matchIndices.length === 0) return;
    currentMatch = (currentMatch + dir + matchIndices.length) % matchIndices.length;
    updateSearchUI();
    scrollToMatch(matchIndices[currentMatch]);
  }

  function updateSearchUI() {
    const countEl = bar.querySelector('#msg-search-count');
    if (countEl) {
      countEl.textContent = matchIndices.length > 0
        ? `${currentMatch + 1}/${matchIndices.length}`
        : input.value ? '0 results' : '';
    }
  }
}

function searchMessages(query: string): number[] {
  if (!query) {
    clearSearchHighlights();
    return [];
  }

  const area = document.getElementById('messages-area');
  if (!area) return [];

  const rows = area.querySelectorAll('.message-row');
  const matches: number[] = [];

  rows.forEach((row, index) => {
    const textEl = row.querySelector('.message-text');
    if (!textEl) return;

    const text = textEl.textContent?.toLowerCase() || '';
    if (text.includes(query)) {
      matches.push(index);
      row.classList.add('search-match');
    } else {
      row.classList.remove('search-match', 'search-match-active');
    }
  });

  return matches;
}

function scrollToMatch(index: number) {
  const area = document.getElementById('messages-area');
  if (!area) return;

  const rows = area.querySelectorAll('.message-row');
  rows.forEach((r) => r.classList.remove('search-match-active'));

  const target = rows[index];
  if (target) {
    target.classList.add('search-match-active');
    target.scrollIntoView({ behavior: 'smooth', block: 'center' });
  }
}

function clearSearchHighlights() {
  const area = document.getElementById('messages-area');
  if (!area) return;
  area.querySelectorAll('.search-match, .search-match-active').forEach((el) => {
    el.classList.remove('search-match', 'search-match-active');
  });
}

export { state as chatState };

// ── Vault Item Sharing ──

const VAULT_ICONS: Record<string, string> = {
  password: '🔑',
  note: '📝',
  card: '💳',
  wifi: '📶',
  file: '📁',
};

function renderVaultItem(bubble: Element, vault: { vaultType: string; label: string; encryptedPayload: string; viewOnce?: boolean; expiresAt?: number }) {
  const textEl = bubble.querySelector('.message-text');
  if (!textEl) return;
  const icon = VAULT_ICONS[vault.vaultType] || '🔐';
  const isExpired = vault.expiresAt && Date.now() / 1000 > vault.expiresAt;
  const viewedKey = `rocchat_vault_viewed_${vault.label}_${vault.encryptedPayload.slice(0, 16)}`;
  const alreadyViewed = vault.viewOnce && localStorage.getItem(viewedKey);

  if (isExpired) {
    textEl.replaceChildren(parseHTML(`<div class="vault-item expired"><span>${icon}</span> <strong>${escapeHtml(vault.label)}</strong><br><em style="color:var(--text-tertiary)">Expired</em></div>`));
    return;
  }
  if (alreadyViewed) {
    textEl.replaceChildren(parseHTML(`<div class="vault-item viewed"><span>${icon}</span> <strong>${escapeHtml(vault.label)}</strong><br><em style="color:var(--text-tertiary)">Already viewed</em></div>`));
    return;
  }

  textEl.replaceChildren(parseHTML(`<div class="vault-item" style="cursor:pointer;padding:12px;background:var(--bg-input);border-radius:var(--radius-md);border:1px solid var(--border-norm)">
    <div style="font-size:1.5em;margin-bottom:4px">${icon}</div>
    <strong>${escapeHtml(vault.label)}</strong>
    <div style="font-size:var(--text-xs);color:var(--text-tertiary);margin-top:4px">${vault.vaultType} · ${vault.viewOnce ? 'view once' : 'tap to reveal'}</div>
  </div>`));

  textEl.querySelector('.vault-item')?.addEventListener('click', () => {
    try {
      // UTF-8 safe base64 decode
      const binaryStr = atob(vault.encryptedPayload);
      const bytes = Uint8Array.from(binaryStr, c => c.charCodeAt(0));
      const decoded = new TextDecoder().decode(bytes);
      const content = formatVaultContent(vault.vaultType, decoded);
      const modal = document.createElement('div');
      modal.className = 'view-once-modal';
      modal.replaceChildren(parseHTML(`<div class="view-once-dialog" style="max-width:360px">
        <h3 style="margin:0 0 12px">${icon} ${escapeHtml(vault.label)}</h3>
        <div style="font-family:var(--font-mono);word-break:break-all;padding:12px;background:var(--bg-input);border-radius:var(--radius-sm);user-select:text">${content}</div>
        <div style="display:flex;gap:8px;margin-top:16px">
          <button class="btn-primary" id="vault-copy" style="flex:1">Copy</button>
          <button class="btn-secondary" id="vault-close" style="flex:1">Close</button>
        </div>
      </div>`));
      document.body.appendChild(modal);
      modal.querySelector('#vault-close')?.addEventListener('click', () => modal.remove());
      modal.addEventListener('click', (e) => { if (e.target === modal) modal.remove(); });
      modal.querySelector('#vault-copy')?.addEventListener('click', () => {
        navigator.clipboard.writeText(decoded);
        showToast('Copied to clipboard', 'success');
      });
      if (vault.viewOnce) {
        localStorage.setItem(viewedKey, '1');
        textEl.replaceChildren(parseHTML(`<div class="vault-item viewed"><span>${icon}</span> <strong>${escapeHtml(vault.label)}</strong><br><em style="color:var(--text-tertiary)">Already viewed</em></div>`));
      }
    } catch {
      showToast('Could not decrypt vault item', 'error');
    }
  });
}

function formatVaultContent(type: string, raw: string): string {
  try {
    const data = JSON.parse(raw);
    switch (type) {
      case 'password':
        return `<div><strong>Username:</strong> ${escapeHtml(data.username || '')}</div><div><strong>Password:</strong> ${escapeHtml(data.password || '')}</div>${data.url ? `<div><strong>URL:</strong> ${escapeHtml(data.url)}</div>` : ''}`;
      case 'wifi':
        return `<div><strong>Network:</strong> ${escapeHtml(data.ssid || '')}</div><div><strong>Password:</strong> ${escapeHtml(data.password || '')}</div><div><strong>Type:</strong> ${escapeHtml(data.security || 'WPA2')}</div>`;
      case 'card':
        return `<div><strong>Card:</strong> •••• ${escapeHtml((data.number || '').slice(-4))}</div><div><strong>Exp:</strong> ${escapeHtml(data.expiry || '')}</div><div><strong>Name:</strong> ${escapeHtml(data.name || '')}</div>`;
      default:
        return escapeHtml(raw);
    }
  } catch {
    return escapeHtml(raw);
  }
}

// escapeHtml defined above

// ── Vault Composer (send vault items from composer) ──

export function showVaultComposer() {
  const overlay = document.createElement('div');
  overlay.className = 'view-once-modal';
  overlay.replaceChildren(parseHTML(`<div class="view-once-dialog" style="max-width:400px">
    <h3 style="margin:0 0 16px">🔐 Share Vault Item</h3>
    <select id="vault-type" class="input" style="width:100%;margin-bottom:12px">
      <option value="password">🔑 Password</option>
      <option value="wifi">📶 WiFi Credentials</option>
      <option value="card">💳 Credit Card</option>
      <option value="note">📝 Secure Note</option>
    </select>
    <input type="text" id="vault-label" class="input" placeholder="Label (e.g. Netflix, Home WiFi)" style="width:100%;margin-bottom:12px">
    <div id="vault-fields"></div>
    <label style="display:flex;align-items:center;gap:8px;margin:12px 0;font-size:var(--text-sm)">
      <input type="checkbox" id="vault-viewonce"> View once (disappears after opened)
    </label>
    <div style="display:flex;gap:8px;margin-top:8px">
      <button class="btn-primary" id="vault-send" style="flex:1">Send</button>
      <button class="btn-secondary" id="vault-cancel" style="flex:1">Cancel</button>
    </div>
  </div>`));
  document.body.appendChild(overlay);
  trapFocusInOverlay(overlay);

  const fieldsDiv = overlay.querySelector('#vault-fields')!;
  const typeSelect = overlay.querySelector('#vault-type') as HTMLSelectElement;

  function renderFields() {
    const type = typeSelect.value;
    let html = '';
    if (type === 'password') {
      html = `<input class="input vault-field" data-key="username" placeholder="Username" autocomplete="off" spellcheck="false" style="width:100%;margin-bottom:8px"><input class="input vault-field" data-key="password" placeholder="Password" type="password" autocomplete="off" style="width:100%;margin-bottom:8px"><input class="input vault-field" data-key="url" placeholder="URL (optional)" autocomplete="off" style="width:100%">`;
    } else if (type === 'wifi') {
      html = `<input class="input vault-field" data-key="ssid" placeholder="Network name (SSID)" autocomplete="off" spellcheck="false" style="width:100%;margin-bottom:8px"><input class="input vault-field" data-key="password" placeholder="Password" type="password" autocomplete="off" style="width:100%">`;
    } else if (type === 'card') {
      html = `<input class="input vault-field" data-key="number" placeholder="Card number" maxlength="19" autocomplete="off" inputmode="numeric" style="width:100%;margin-bottom:8px"><input class="input vault-field" data-key="expiry" placeholder="MM/YY" maxlength="5" autocomplete="off" style="width:100%;margin-bottom:8px"><input class="input vault-field" data-key="name" placeholder="Cardholder name" autocomplete="off" spellcheck="false" style="width:100%">`;
    } else {
      html = `<textarea class="input vault-field" data-key="note" placeholder="Secure note content" rows="4" style="width:100%;resize:vertical"></textarea>`;
    }
    fieldsDiv.replaceChildren(parseHTML(html));
  }
  typeSelect.addEventListener('change', renderFields);
  renderFields();

  overlay.querySelector('#vault-cancel')?.addEventListener('click', () => overlay.remove());
  overlay.addEventListener('click', (e) => { if (e.target === overlay) overlay.remove(); });

  overlay.querySelector('#vault-send')?.addEventListener('click', async () => {
    const label = (overlay.querySelector('#vault-label') as HTMLInputElement).value.trim();
    if (!label) { showToast('Label is required', 'error'); return; }

    const fields: Record<string, string> = {};
    overlay.querySelectorAll('.vault-field').forEach(f => {
      const key = (f as HTMLElement).dataset.key || '';
      fields[key] = (f as HTMLInputElement | HTMLTextAreaElement).value;
    });

    const viewOnce = (overlay.querySelector('#vault-viewonce') as HTMLInputElement).checked;
    const payload = btoa(JSON.stringify(fields));

    const vaultMsg = JSON.stringify({
      type: 'vault_item',
      vaultType: typeSelect.value,
      label,
      encryptedPayload: payload,
      viewOnce,
      timestamp: Date.now(),
    });

    // Send as encrypted message through the normal flow
    const convId = state.activeConversationId;
    if (!convId) return;
    const conv = state.conversations.find(c => c.id === convId);
    if (!conv) return;
    const recipientId = (conv as any).members?.find((m: any) => m.user_id !== localStorage.getItem('rocchat_user_id'))?.user_id || '';

    try {
      const { encryptMessage: enc, getOrCreateSession: getSession } = await import('../crypto/session-manager.js');
      await getSession(convId, recipientId);
      const encrypted = await enc(convId, recipientId, vaultMsg);
      const headerObj = (encrypted as any).x3dh ? { ...encrypted.header, tag: encrypted.tag, x3dh: (encrypted as any).x3dh } : { ...encrypted.header, tag: encrypted.tag };
      await api.sendMessage({
        conversation_id: convId,
        ciphertext: encrypted.ciphertext,
        iv: encrypted.iv,
        tag: encrypted.tag,
        ratchet_header: JSON.stringify(headerObj),
        message_type: 'vault_item',
      });
      showToast('Vault item sent', 'success');
      overlay.remove();
    } catch {
      showToast('Failed to send vault item', 'error');
    }
  });
}

// ── Message Context Menu ──

const QUICK_REACTIONS = ['👍', '❤️', '😂', '😮', '😢', '🙏'];

function showMessageContextMenu(e: MouseEvent, msgId: string, isMine: boolean, conversationId: string) {
  // Remove any existing context menu
  document.querySelector('.msg-context-menu')?.remove();

  const menu = document.createElement('div');
  menu.className = 'msg-context-menu';

  // Quick reaction bar
  const reactionBar = document.createElement('div');
  reactionBar.className = 'ctx-reaction-bar';
  QUICK_REACTIONS.forEach(emoji => {
    const btn = document.createElement('button');
    btn.className = 'ctx-reaction-btn';
    btn.textContent = emoji;
    btn.addEventListener('click', () => {
      reactToMsg(msgId, conversationId, emoji);
      menu.remove();
    });
    reactionBar.appendChild(btn);
  });
  menu.appendChild(reactionBar);

  // Menu items
  const items: { label: string; icon: string; action: () => void; condition?: boolean }[] = [
    {
      label: 'Reply',
      icon: '↩️',
      action: () => {
        const input = document.getElementById('message-input') as HTMLTextAreaElement;
        if (input) {
          input.focus();
          input.dataset.replyTo = msgId;
          // Show reply banner above composer
          document.getElementById('reply-banner')?.remove();
          const quoted = plaintextCache.get(msgId);
          const snippet = quoted ? (quoted.length > 60 ? quoted.slice(0, 60) + '…' : quoted) : '🔒 Encrypted message';
          const banner = document.createElement('div');
          banner.id = 'reply-banner';
          banner.className = 'reply-banner';
          banner.replaceChildren(parseHTML(`<span class="reply-banner-text">↩️ ${escapeHtml(snippet)}</span><button class="reply-banner-close" aria-label="Cancel reply">✕</button>`));
          banner.querySelector('.reply-banner-close')?.addEventListener('click', () => {
            delete input.dataset.replyTo;
            banner.remove();
          });
          const composer = document.querySelector('.composer');
          if (composer) composer.parentElement?.insertBefore(banner, composer);
        }
        menu.remove();
      },
    },
    {
      label: 'Copy',
      icon: '📋',
      action: async () => {
        const textEl = document.querySelector(`[data-msg-id="${msgId}"] .message-text`);
        try {
          if (textEl) await navigator.clipboard.writeText(textEl.textContent || '');
          showToast('Copied', 'info');
        } catch { showToast('Copy failed', 'error'); }
        menu.remove();
      },
    },
    {
      label: 'Forward',
      icon: '↪',
      action: () => {
        menu.remove();
        const plaintext = plaintextCache.get(msgId)
          ?? (document.querySelector(`[data-msg-id="${msgId}"] .message-text`) as HTMLElement | null)?.textContent
          ?? '';
        openForwardDialog(msgId, plaintext);
      },
    },
    {
      label: 'Pin',
      icon: '📌',
      action: async () => {
        menu.remove();
        await api.pinMessage(conversationId, msgId);
        showToast('Message pinned', 'info');
      },
    },
    {
      label: 'Edit',
      icon: '✏️',
      action: () => {
        menu.remove();
        startEditMessage(msgId, conversationId);
      },
      condition: isMine,
    },
    {
      label: 'Delete',
      icon: '🗑️',
      action: async () => {
        menu.remove();
        if (confirm('Delete this message?')) {
          await api.deleteMessage(msgId);
          const msgs = state.messages.get(conversationId);
          const msg = msgs?.find(m => m.id === msgId);
          if (msg) { msg.deleted_at = Date.now(); renderMessages(msgs!); }
        }
      },
      condition: isMine,
    },
    {
      label: 'Block User',
      icon: '🚫',
      action: async () => {
        menu.remove();
        const msgs = state.messages.get(conversationId);
        const msg = msgs?.find(m => m.id === msgId);
        if (!msg) return;
        if (confirm('Block this user? They will not be able to message you.')) {
          try {
            await api.blockContact(msg.sender_id, true);
            showToast('User blocked', 'info');
          } catch { showToast('Failed to block user', 'error'); }
        }
      },
      condition: !isMine,
    },
  ];

  items.forEach(({ label, icon, action, condition }) => {
    if (condition === false) return;
    const item = document.createElement('button');
    item.className = 'ctx-menu-item';
    item.replaceChildren(parseHTML(`<span class="ctx-icon">${icon}</span>${label}`));
    item.addEventListener('click', action);
    menu.appendChild(item);
  });

  // Position
  menu.style.top = `${Math.min(e.clientY, window.innerHeight - 280)}px`;
  menu.style.left = `${Math.min(e.clientX, window.innerWidth - 200)}px`;
  document.body.appendChild(menu);

  // Dismiss on click outside
  const dismiss = (ev: MouseEvent) => {
    if (!menu.contains(ev.target as Node)) {
      menu.remove();
      document.removeEventListener('click', dismiss, true);
    }
  };
  setTimeout(() => document.addEventListener('click', dismiss, true), 0);
}

async function reactToMsg(msgId: string, conversationId: string, emoji: string) {
  try {
    const encryptedReaction = await encryptProfileField(emoji);
    await api.addReaction(msgId, encryptedReaction);
    updateReactionUI(msgId, localStorage.getItem('rocchat_user_id') || '', emoji);
  } catch {
    showToast('Failed to react', 'error');
  }
}

function updateReactionUI(msgId: string, userId: string, reaction: string | null) {
  const row = document.getElementById(`reactions-${msgId}`);
  if (!row) return;
  const myId = localStorage.getItem('rocchat_user_id') || '';

  const display = reaction;
  const groupKey = reaction || '';

  // Remove this user's previous reaction (toggle / replace semantics).
  const previous = row.querySelector(`[data-reaction-user="${userId}"]`);
  if (previous) {
    const prevGroup = previous.getAttribute('data-reaction-group') || '';
    const prevChip = row.querySelector(`[data-reaction-chip="${prevGroup}"]`) as HTMLElement | null;
    if (prevChip) {
      const count = parseInt(prevChip.getAttribute('data-count') || '1', 10) - 1;
      if (count <= 0) prevChip.remove();
      else {
        prevChip.setAttribute('data-count', String(count));
        const numEl = prevChip.querySelector('.reaction-count');
        if (numEl) numEl.textContent = String(count);
      }
    }
    previous.remove();
  }
  if (!reaction) return;

  // Track membership (one tag per user).
  const memberTag = document.createElement('span');
  memberTag.style.display = 'none';
  memberTag.dataset.reactionUser = userId;
  memberTag.dataset.reactionGroup = groupKey;
  row.appendChild(memberTag);

  // Aggregate chip per (group + emoji).
  let chip = row.querySelector(`[data-reaction-chip="${groupKey}"]`) as HTMLButtonElement | null;
  if (!chip) {
    chip = document.createElement('button');
    chip.type = 'button';
    chip.className = 'reaction-chip';
    chip.setAttribute('data-reaction-chip', groupKey);
    chip.setAttribute('data-count', '0');
    chip.setAttribute('aria-label', isLocal ? `Your reaction ${display}` : 'Reaction');
    chip.replaceChildren(parseHTML(`<span class="reaction-glyph">${display}</span><span class="reaction-count">0</span>`));
    chip.addEventListener('click', async () => {
      // Tapping your own chip removes it; tapping someone else's adds the
      // same emoji from you (mirrors Slack/Telegram/iMessage behaviour).
      if (isLocal) {
        await api.removeReaction(msgId);
        updateReactionUI(msgId, myId, null);
      } else if (display) {
        // Best-effort: react with sparkle glyph until per-conv ratchet
        // decrypt is wired up. Local user gets immediate optimistic chip.
        const conv = state.conversations.find(c => c.id === (window as any).__activeConvId);
        if (!conv) return;
        try {
          const recipientId = (conv as any).members?.find((m: any) => m.user_id !== myId)?.user_id || '';
          const enc = await encryptMessage(conv.id, recipientId, '✨');
          await api.addReaction(msgId, enc.ciphertext);
          updateReactionUI(msgId, myId, '✨');
        } catch { /* ignore */ }
      }
    });
    row.appendChild(chip);
  }
  const next = parseInt(chip.getAttribute('data-count') || '0', 10) + 1;
  chip.setAttribute('data-count', String(next));
  const numEl = chip.querySelector('.reaction-count');
  if (numEl) numEl.textContent = String(next);
}

function startEditMessage(msgId: string, conversationId: string) {
  const textEl = document.querySelector(`[data-msg-id="${msgId}"] .message-text`) as HTMLElement;
  if (!textEl) return;
  const original = textEl.textContent || '';
  const input = document.createElement('textarea');
  input.className = 'edit-message-input';
  input.value = original;
  textEl.replaceWith(input);
  input.focus();

  const saveEdit = async () => {
    const newText = input.value.trim();
    if (!newText || newText === original) {
      input.replaceWith(textEl);
      return;
    }
    try {
      const conv = state.conversations.find(c => c.id === conversationId);
      let encPayload: string;
      if (conv?.type === 'group') {
        const groupEnc = await groupEncrypt(conversationId, conv.members, newText);
        encPayload = JSON.stringify({ ciphertext: groupEnc.ciphertext, iv: groupEnc.iv, ratchet_header: groupEnc.ratchet_header, message_type: 'text' });
      } else {
        const recipientId = (conv as any)?.members?.find((m: any) => m.user_id !== localStorage.getItem('rocchat_user_id'))?.user_id || '';
        await getOrCreateSession(conversationId, recipientId);
        const encrypted = await encryptMessage(conversationId, recipientId, newText);
        const enc = encrypted as unknown as Record<string, unknown>;
        const headerObj = {
          ...encrypted.header,
          tag: encrypted.tag,
          ...(enc.x3dh ? { x3dh: enc.x3dh } : {}),
        };
        encPayload = JSON.stringify({ ciphertext: encrypted.ciphertext, iv: encrypted.iv, tag: encrypted.tag, ratchet_header: JSON.stringify(headerObj), message_type: 'text' });
      }
      await api.editMessage(msgId, encPayload);
      textEl.textContent = newText;
      input.replaceWith(textEl);
      // Add edited indicator
      const meta = document.querySelector(`[data-msg-id="${msgId}"] .message-meta`);
      if (meta && !meta.querySelector('.message-edited')) {
        meta.insertAdjacentHTML('afterbegin', '<span class="message-edited" title="Edited">edited</span>');
      }
      showToast('Message edited', 'info');
    } catch {
      showToast('Failed to edit', 'error');
      input.replaceWith(textEl);
    }
  };

  input.addEventListener('keydown', (ev) => {
    if (ev.key === 'Enter' && !ev.shiftKey) { ev.preventDefault(); saveEdit(); }
    if (ev.key === 'Escape') input.replaceWith(textEl);
  });
  input.addEventListener('blur', saveEdit);
}

// ── Pinned Messages Panel ──

async function showPinnedMessages(conversationId: string) {
  // Remove existing panel
  document.querySelector('.pinned-panel')?.remove();

  const panel = document.createElement('div');
  panel.className = 'pinned-panel';
  panel.replaceChildren(parseHTML(`
    <div class="pinned-panel-header">
      <h3>📌 Pinned Messages</h3>
      <button class="icon-btn pinned-close" aria-label="Close">&times;</button>
    </div>
    <div class="pinned-panel-body"><p style="text-align:center;opacity:0.5">Loading...</p></div>
  `));

  const chatView = document.querySelector('.chat-view');
  if (!chatView) return;
  chatView.appendChild(panel);

  panel.querySelector('.pinned-close')?.addEventListener('click', () => panel.remove());

  try {
    const res = await api.getPinnedMessages(conversationId);
    const body = panel.querySelector('.pinned-panel-body')!;
    const pins = (res as any).data || [];
    if (!pins.length) {
      body.replaceChildren(parseHTML('<p style="text-align:center;opacity:0.5;padding:20px">No pinned messages</p>'));
      return;
    }
    body.replaceChildren();
    for (const pin of pins) {
      const div = document.createElement('div');
      div.className = 'pinned-item';
      div.replaceChildren(parseHTML(`
        <div class="pinned-text">${escapeHtml(pin.ciphertext?.substring(0, 100) || '🔒 Encrypted')}</div>
        <div class="pinned-meta">${formatTime(pin.pinned_at)} · pinned by ${escapeHtml(pin.pinned_by?.substring(0, 8) || '?')}</div>
        <button class="pinned-unpin" data-mid="${pin.message_id}">Unpin</button>
      `));
      div.querySelector('.pinned-unpin')?.addEventListener('click', async (e) => {
        const mid = (e.target as HTMLElement).dataset.mid!;
        await api.unpinMessage(conversationId, mid);
        div.remove();
        showToast('Unpinned', 'info');
      });
      // Click to scroll to message
      div.addEventListener('click', (e) => {
        if ((e.target as HTMLElement).classList.contains('pinned-unpin')) return;
        const msgEl = document.querySelector(`[data-msg-id="${pin.message_id}"]`);
        if (msgEl) {
          msgEl.scrollIntoView({ behavior: 'smooth', block: 'center' });
          msgEl.classList.add('message-highlight');
          setTimeout(() => msgEl.classList.remove('message-highlight'), 2000);
        }
      });
      body.appendChild(div);
    }
  } catch {
    const body = panel.querySelector('.pinned-panel-body');
    if (body) body.replaceChildren(parseHTML('<p style="text-align:center;color:#e74c3c">Failed to load pinned messages</p>'));
  }
}
