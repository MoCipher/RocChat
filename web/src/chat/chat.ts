/**
 * RocChat Web — Chat UI
 *
 * Conversation list + message view + composer.
 */

import * as api from '../api.js';
import type { Conversation, Message } from '../api.js';
import { encryptMessage, decryptMessage, getOrCreateSession } from '../crypto/session-manager.js';
import type { EncryptedMessage } from '@rocchat/shared';
import { generateSafetyNumber, fromBase64 } from '@rocchat/shared';

interface ChatState {
  conversations: Conversation[];
  activeConversationId: string | null;
  messages: Map<string, Message[]>;
  ws: WebSocket | null;
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

// ── Offline message queue (persisted in IndexedDB) ──
const messageQueue: QueuedMessage[] = [];

const MQ_DB_NAME = 'rocchat_mq';
const MQ_STORE = 'queue';

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
        for (const item of req.result) messageQueue.push(item);
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
  } catch { /* best effort */ }
}

async function removeQueueItem(localId: string): Promise<void> {
  try {
    const db = await openMqDb();
    const tx = db.transaction(MQ_STORE, 'readwrite');
    tx.objectStore(MQ_STORE).delete(localId);
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
  document.getElementById('offline-banner')?.classList.remove('visible');
});

window.addEventListener('offline', () => {
  showToast('You are offline — messages will be queued', 'error');
  document.getElementById('offline-banner')?.classList.add('visible');
});

// ── Toast Notifications ──
function showToast(message: string, type: 'success' | 'error' | 'info' = 'info') {
  let container = document.querySelector('.toast-container');
  if (!container) {
    container = document.createElement('div');
    container.className = 'toast-container';
    container.setAttribute('role', 'alert');
    container.setAttribute('aria-live', 'polite');
    document.body.appendChild(container);
  }
  const toast = document.createElement('div');
  toast.className = `toast toast-${type}`;
  toast.textContent = message;
  container.appendChild(toast);
  setTimeout(() => {
    toast.classList.add('toast-exit');
    toast.addEventListener('animationend', () => toast.remove());
  }, 3000);
}

export async function renderChats(container: HTMLElement) {
  container.innerHTML = `
    <div class="panel-list" id="conversations-panel">
      <div class="panel-header">
        <div class="panel-header-top">
          <h2>Chats</h2>
          <button class="icon-btn" id="new-chat-btn" title="New conversation">
            <i data-lucide="edit" style="width:18px;height:18px"></i>
          </button>
        </div>
        <div class="search-box">
          <i data-lucide="search" style="width:16px;height:16px;color:var(--text-tertiary)"></i>
          <input type="text" placeholder="Search..." id="chat-search" />
        </div>
      </div>
      <div class="conversations-list" id="conversations-list">
        <div class="empty-state" style="padding:var(--sp-8)">
          <p style="font-size:var(--text-sm);color:var(--text-tertiary)">Loading conversations...</p>
        </div>
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
  `;

  // Load conversations
  try {
    const res = await api.getConversations();
    if (res.ok) {
      state.conversations = res.data.conversations || [];
      renderConversationsList();
    }
  } catch {
    // Network error — show empty
  }

  // Bind new chat
  container.querySelector('#new-chat-btn')?.addEventListener('click', () => {
    showNewChatDialog(container);
  });

  // Search filter (debounced)
  let searchTimeout: ReturnType<typeof setTimeout>;
  container.querySelector('#chat-search')?.addEventListener('input', (e) => {
    clearTimeout(searchTimeout);
    const q = (e.target as HTMLInputElement).value.toLowerCase();
    searchTimeout = setTimeout(() => renderConversationsList(q), 200);
  });

  if (typeof (window as any).lucide !== 'undefined') {
    (window as any).lucide.createIcons();
  }
}

function renderConversationsList(filter = '') {
  const list = document.getElementById('conversations-list');
  if (!list) return;

  const userId = localStorage.getItem('rocchat_user_id') || '';
  let filtered = state.conversations;
  if (filter) {
    filtered = filtered.filter((c) => {
      const name = getConversationName(c, userId).toLowerCase();
      return name.includes(filter);
    });
  }

  if (filtered.length === 0) {
    list.innerHTML = `
      <div class="empty-state" style="padding:var(--sp-8);text-align:center">
        <div style="font-size:48px;margin-bottom:var(--sp-4);opacity:0.4">${filter ? '🔍' : '💬'}</div>
        <p style="font-size:var(--text-sm);color:var(--text-secondary);margin-bottom:var(--sp-2)">
          ${filter ? 'No matching conversations' : 'No conversations yet'}
        </p>
        ${!filter ? '<p style="font-size:var(--text-xs);color:var(--text-tertiary)">Tap the <strong>✏️</strong> button above to start a new chat</p>' : ''}
      </div>
    `;
    return;
  }

  list.innerHTML = filtered
    .map((c) => {
      const name = getConversationName(c, userId);
      const initials = name
        .split(' ')
        .map((w) => w[0])
        .join('')
        .slice(0, 2)
        .toUpperCase();
      const time = c.last_message_at ? formatTime(c.last_message_at) : '';
      const isActive = c.id === state.activeConversationId;

      return `
        <div class="conversation-item ${isActive ? 'active' : ''}" data-id="${c.id}">
          <div class="avatar">${initials}</div>
          <div class="conversation-info">
            <div class="conversation-name">${escapeHtml(name)}</div>
            <div class="conversation-preview">Encrypted message</div>
          </div>
          <div class="conversation-meta">
            <span class="conversation-time">${time}</span>
          </div>
        </div>
      `;
    })
    .join('');

  // Bind clicks
  list.querySelectorAll('.conversation-item').forEach((el) => {
    el.addEventListener('click', () => {
      const id = (el as HTMLElement).dataset.id!;
      openConversation(id);
    });
  });
}

async function openConversation(conversationId: string) {
  state.activeConversationId = conversationId;
  renderConversationsList(); // Update active state

  const conv = state.conversations.find((c) => c.id === conversationId);
  if (!conv) return;

  const userId = localStorage.getItem('rocchat_user_id') || '';
  const name = getConversationName(conv, userId);

  const chatView = document.getElementById('chat-view');
  if (!chatView) return;

  chatView.innerHTML = `
    <div class="chat-header">
      <button class="mobile-back-btn" id="btn-back" aria-label="Back to conversations">
        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M15 18l-6-6 6-6"/></svg>
      </button>
      <div class="avatar" style="width:36px;height:36px;font-size:var(--text-xs)">
        ${name.split(' ').map((w) => w[0]).join('').slice(0, 2).toUpperCase()}
      </div>
      <div class="chat-header-info">
        <div class="chat-header-name">${escapeHtml(name)}</div>
        <div class="chat-header-status">
          <span style="font-size:8px">🔒</span> End-to-end encrypted
        </div>
      </div>
      <div class="chat-header-actions">
        <button class="icon-btn" title="Verify safety number" id="btn-verify" aria-label="Verify safety number">
          <i data-lucide="shield-check" style="width:18px;height:18px"></i>
        </button>
        <button class="icon-btn" title="Disappearing messages" id="btn-disappear" aria-label="Disappearing messages">
          <i data-lucide="timer" style="width:18px;height:18px"></i>
        </button>
        <button class="icon-btn" title="Voice call" id="btn-voice-call" aria-label="Voice call">
          <i data-lucide="phone" style="width:18px;height:18px"></i>
        </button>
        <button class="icon-btn" title="Video call" id="btn-video-call" aria-label="Video call">
          <i data-lucide="video" style="width:18px;height:18px"></i>
        </button>
        <button class="icon-btn" title="Info" id="btn-chat-info" aria-label="Conversation info">
          <i data-lucide="info" style="width:18px;height:18px"></i>
        </button>
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
        <i data-lucide="paperclip" style="width:18px;height:18px"></i>
      </button>
      <textarea class="composer-input" id="message-input" placeholder="Type a message..."
                rows="1" aria-label="Message"></textarea>
      <button class="send-btn" id="send-btn" disabled title="Send" aria-label="Send message">
        <i data-lucide="send" style="width:18px;height:18px"></i>
      </button>
    </div>
  `;

  // Mobile responsive: mark layout as having open conversation
  document.querySelector('.app-layout')?.classList.add('has-conversation');

  // Bind back button for mobile
  chatView.querySelector('#btn-back')?.addEventListener('click', () => {
    state.activeConversationId = null;
    document.querySelector('.app-layout')?.classList.remove('has-conversation');
    renderConversationsList();
    const cv = document.getElementById('chat-view');
    if (cv) cv.innerHTML = `
      <div class="empty-state">
        <div class="empty-state-icon">
          <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="var(--roc-gold)" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" opacity="0.4">
            <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/>
          </svg>
        </div>
        <h3>Select a conversation</h3>
        <p>Choose from your chats or start a new one.</p>
      </div>
    `;
  });

  // Load messages
  await loadMessages(conversationId);

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
  });

  input?.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      if (input.value.trim()) sendMessageHandler();
    }
  });

  sendBtn?.addEventListener('click', sendMessageHandler);

  // Bind disappearing messages timer
  chatView.querySelector('#btn-disappear')?.addEventListener('click', () => {
    showDisappearingMenu(conversationId);
  });

  // Bind safety number verification
  chatView.querySelector('#btn-verify')?.addEventListener('click', () => {
    if (conv) showSafetyNumber(conv);
  });

  // Bind call buttons
  chatView.querySelector('#btn-voice-call')?.addEventListener('click', () => {
    if (conv) startCall(conv, 'voice');
  });
  chatView.querySelector('#btn-video-call')?.addEventListener('click', () => {
    if (conv) startCall(conv, 'video');
  });

  // Bind attach button
  chatView.querySelector('.composer .icon-btn[title="Attach file"]')?.addEventListener('click', () => {
    if (state.activeConversationId) showFileUpload(state.activeConversationId);
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
    }
  } catch {
    // Offline — show cached
  }
}

function renderMessages(messages: Message[]) {
  const area = document.getElementById('messages-area');
  if (!area) return;

  const userId = localStorage.getItem('rocchat_user_id') || '';

  // Keep encryption banner
  const banner = area.querySelector('.encryption-banner')?.outerHTML || '';
  area.innerHTML = banner;

  messages.forEach((msg) => {
    const isMine = msg.sender_id === userId;
    const div = document.createElement('div');
    div.className = `message-row ${isMine ? 'mine' : 'theirs'}`;
    div.dataset.msgId = msg.id;

    // Try to decrypt if we have ratchet data
    const hasRatchet = msg.ratchet_header && msg.iv && msg.ciphertext;
    const displayText = hasRatchet ? '🔒 Decrypting...' : msg.ciphertext;

    div.innerHTML = `
      <div class="message-bubble">
        <div class="message-text">${escapeHtml(displayText)}</div>
        <div class="message-meta">
          <span class="message-lock">🔒</span>
          <span class="message-time">${formatTime(msg.created_at)}</span>
          ${isMine ? '<span class="message-status">✓✓</span>' : ''}
        </div>
      </div>
    `;
    area.appendChild(div);

    // Async decrypt
    if (hasRatchet && !isMine) {
      let header;
      try { header = JSON.parse(msg.ratchet_header); } catch {
        const textEl = div.querySelector('.message-text');
        if (textEl) textEl.textContent = '🔒 Unable to decrypt';
        return;
      }
      const encrypted: EncryptedMessage = {
        header,
        ciphertext: msg.ciphertext,
        iv: msg.iv,
        tag: '', // tag is appended to ciphertext in our format
      };
      decryptMessage(msg.conversation_id, encrypted)
        .then((plaintext) => {
          const textEl = div.querySelector('.message-text');
          if (textEl) textEl.textContent = plaintext;
        })
        .catch(() => {
          const textEl = div.querySelector('.message-text');
          if (textEl) textEl.textContent = '🔒 Unable to decrypt';
        });
    }
  });

  area.scrollTop = area.scrollHeight;
}

async function sendMessageHandler() {
  const input = document.getElementById('message-input') as HTMLTextAreaElement;
  const sendBtn = document.getElementById('send-btn') as HTMLButtonElement;
  if (!input || !state.activeConversationId) return;

  const text = input.value.trim();
  if (!text) return;

  input.value = '';
  input.style.height = 'auto';
  sendBtn.disabled = true;

  const conv = state.conversations.find((c) => c.id === state.activeConversationId);
  const userId = localStorage.getItem('rocchat_user_id') || '';
  const recipientUserId = conv?.members.find((m) => m.user_id !== userId)?.user_id;
  const localId = `queued-${Date.now()}`;

  try {
    const expiresIn = disappearTimers.get(state.activeConversationId) || undefined;
    let payload: Parameters<typeof api.sendMessage>[0];

    if (recipientUserId) {
      // Encrypt with Double Ratchet
      const encrypted = await encryptMessage(state.activeConversationId, recipientUserId, text);
      // Include X3DH header in ratchet_header if this is the first message
      const enc = encrypted as unknown as Record<string, unknown>;
      const headerObj = enc.x3dh
        ? { ...encrypted.header, x3dh: enc.x3dh }
        : encrypted.header;
      payload = {
        conversation_id: state.activeConversationId,
        ciphertext: encrypted.ciphertext,
        iv: encrypted.iv,
        ratchet_header: JSON.stringify(headerObj),
        message_type: 'text',
        expires_in: expiresIn,
      };
    } else {
      // Fallback for group or unknown
      payload = {
        conversation_id: state.activeConversationId,
        ciphertext: text,
        iv: '',
        ratchet_header: '',
        expires_in: expiresIn,
      };
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
    });
    state.messages.set(state.activeConversationId, msgs);
    renderMessages(msgs);

    // Try to send; queue on failure
    try {
      await api.sendMessage(payload);
    } catch {
      const queueItem: QueuedMessage = { payload, localId, conversationId: state.activeConversationId };
      messageQueue.push(queueItem);
      persistQueueItem(queueItem);
      showToast('Message queued — will send when online', 'error');
    }
  } catch {
    input.value = text;
    sendBtn.disabled = false;
    showToast('Failed to encrypt message', 'error');
  }
}

function connectWebSocket(conversationId: string) {
  // Close existing WS
  if (state.ws) {
    state.ws.close();
    state.ws = null;
  }

  const token = api.getToken();
  const userId = localStorage.getItem('rocchat_user_id') || '';
  if (!token || !userId) return;

  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
  const wsUrl = `${proto}//${location.host}/api/ws/${conversationId}?userId=${userId}&deviceId=web&token=${token}`;

  try {
    const ws = new WebSocket(wsUrl);
    state.ws = ws;

    ws.addEventListener('open', () => {
      if (messageQueue.length > 0) flushMessageQueue();
    });

    ws.addEventListener('message', async (event) => {
      try {
        const data = JSON.parse(event.data);

        switch (data.type) {
          case 'message': {
            const payload = data.payload;
            const msgs = state.messages.get(conversationId) || [];

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
                const encrypted: EncryptedMessage = {
                  header,
                  ciphertext: payload.ciphertext,
                  iv: payload.iv,
                  tag: payload.tag || '',
                };
                displayText = await decryptMessage(conversationId, encrypted);
              } catch {
                displayText = '🔒 Unable to decrypt';
              }
            }

            msgs.push({
              id: payload.id || `ws-${Date.now()}`,
              conversation_id: conversationId,
              sender_id: payload.fromUserId || payload.sender_id,
              ciphertext: displayText,
              iv: '',
              ratchet_header: '',
              message_type: payload.message_type || 'text',
              created_at: payload.created_at || new Date().toISOString(),
            });
            state.messages.set(conversationId, msgs);
            renderMessages(msgs);
            break;
          }

          case 'typing': {
            const typingEl = document.querySelector('.chat-header-status');
            if (typingEl && data.payload.isTyping) {
              typingEl.innerHTML = `<span class="typing-indicator"><span></span><span></span><span></span></span> typing...`;
              setTimeout(() => {
                if (typingEl) typingEl.innerHTML = `<span style="font-size:8px">🔒</span> End-to-end encrypted`;
              }, 3000);
            }
            break;
          }

          case 'presence': {
            const statusEl = document.querySelector('.chat-header-status');
            if (statusEl && data.payload.status === 'online') {
              statusEl.setAttribute('data-online', 'true');
            }
            break;
          }

          case 'read_receipt': {
            // Mark messages as read
            const msgIds = data.payload.messageIds as string[] | undefined;
            if (msgIds) {
              msgIds.forEach((id: string) => {
                const el = document.querySelector(`[data-msg-id="${id}"] .message-status`);
                if (el) el.textContent = '✓✓';
              });
            }
            break;
          }

          case 'call_offer': {
            handleIncomingCall(data.payload, conversationId);
            break;
          }
        }
      } catch { /* ignore malformed */ }
    });

    ws.addEventListener('close', () => {
      state.ws = null;
      // Auto-reconnect after 3 seconds if still viewing this conversation
      setTimeout(() => {
        if (state.activeConversationId === conversationId && !state.ws) {
          connectWebSocket(conversationId);
        }
      }, 3000);
    });

    ws.addEventListener('error', () => {
      // Error will also trigger close event → reconnect handled there
      state.ws = null;
    });

    // Send typing indicators
    const input = document.getElementById('message-input');
    let typingTimeout: ReturnType<typeof setTimeout>;
    input?.addEventListener('input', () => {
      if (!state.ws || state.ws.readyState !== WebSocket.OPEN) return;
      clearTimeout(typingTimeout);
      state.ws.send(JSON.stringify({ type: 'typing', payload: { isTyping: true } }));
      typingTimeout = setTimeout(() => {
        if (state.ws?.readyState === WebSocket.OPEN) {
          state.ws.send(JSON.stringify({ type: 'typing', payload: { isTyping: false } }));
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
  overlay.innerHTML = `
    <div class="auth-card" style="max-width:360px">
      <h2 style="font-size:var(--text-lg);margin-bottom:var(--sp-4)">New Conversation</h2>
      <div class="form-group">
        <label class="form-label">Search by username</label>
        <div class="search-box">
          <input type="text" placeholder="@username" id="search-user-input" />
        </div>
      </div>
      <div id="search-results" style="margin-bottom:var(--sp-4)"></div>
      <button class="btn-secondary" id="close-dialog">Cancel</button>
    </div>
  `;

  document.body.appendChild(overlay);

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
        results.innerHTML = '<p style="font-size:var(--text-sm);color:var(--text-tertiary)">No users found.</p>';
        return;
      }

      results.innerHTML = users
        .map(
          (u) => `
        <div class="conversation-item" data-user-id="${u.userId}" style="cursor:pointer">
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
        .join('');

      results.querySelectorAll('.conversation-item').forEach((el) => {
        el.addEventListener('click', async () => {
          const uid = (el as HTMLElement).dataset.userId!;
          const convRes = await api.createConversation({
            type: 'direct',
            member_ids: [uid],
          });
          if (convRes.ok) {
            overlay.remove();
            // Reload conversations and open the new one
            const listRes = await api.getConversations();
            if (listRes.ok) {
              state.conversations = listRes.data.conversations || [];
              renderConversationsList();
              openConversation(convRes.data.conversation_id);
            }
          }
        });
      });
    }, 300);
  });
}

// ── Disappearing Messages ──

const disappearTimers = new Map<string, number>(); // conversationId → seconds

function showDisappearingMenu(conversationId: string) {
  const currentTimer = disappearTimers.get(conversationId) || 0;
  const overlay = document.createElement('div');
  overlay.style.cssText = `
    position:fixed;inset:0;background:rgba(0,0,0,0.5);z-index:50;
    display:flex;align-items:center;justify-content:center;padding:var(--sp-4);
  `;

  const options = [
    { label: 'Off', value: 0 },
    { label: '5 minutes', value: 300 },
    { label: '1 hour', value: 3600 },
    { label: '24 hours', value: 86400 },
    { label: '7 days', value: 604800 },
    { label: '30 days', value: 2592000 },
  ];

  overlay.innerHTML = `
    <div class="auth-card" style="max-width:320px">
      <h2 style="font-size:var(--text-lg);margin-bottom:var(--sp-2)">Disappearing Messages</h2>
      <p style="font-size:var(--text-sm);color:var(--text-tertiary);margin-bottom:var(--sp-4)">
        New messages will auto-delete after the selected time.
      </p>
      <div style="display:flex;flex-direction:column;gap:var(--sp-2)">
        ${options
          .map(
            (o) => `
          <button class="btn-secondary disappear-option ${currentTimer === o.value ? 'active' : ''}"
                  data-value="${o.value}"
                  style="${currentTimer === o.value ? 'border-color:var(--roc-gold);color:var(--roc-gold)' : ''}">
            ${o.label}
          </button>
        `,
          )
          .join('')}
      </div>
      <button class="btn-secondary" id="close-disappear" style="margin-top:var(--sp-3)">Cancel</button>
    </div>
  `;

  document.body.appendChild(overlay);

  overlay.querySelector('#close-disappear')?.addEventListener('click', () => overlay.remove());
  overlay.addEventListener('click', (e) => {
    if (e.target === overlay) overlay.remove();
  });

  overlay.querySelectorAll('.disappear-option').forEach((btn) => {
    btn.addEventListener('click', () => {
      const value = parseInt((btn as HTMLElement).dataset.value || '0', 10);
      disappearTimers.set(conversationId, value);

      // Update the timer icon to indicate active
      const timerBtn = document.getElementById('btn-disappear');
      if (timerBtn) {
        timerBtn.style.color = value > 0 ? 'var(--turquoise)' : '';
        timerBtn.title = value > 0
          ? `Disappearing: ${options.find((o) => o.value === value)?.label}`
          : 'Disappearing messages';
      }

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
  const overlay = document.createElement('div');
  overlay.style.cssText = `
    position:fixed;inset:0;background:rgba(0,0,0,0.5);z-index:50;
    display:flex;align-items:center;justify-content:center;padding:var(--sp-4);
  `;

  overlay.innerHTML = `
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
      </div>
    </div>
  `;

  document.body.appendChild(overlay);

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
}

// ── Helpers ──

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

function escapeHtml(text: string): string {
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}

// ── Call initiation ──

async function startCall(conv: Conversation, callType: 'voice' | 'video') {
  const { startOutgoingCall } = await import('../calls/calls.js');
  const userId = localStorage.getItem('rocchat_user_id') || '';
  const recipient = conv.members.find((m) => m.user_id !== userId);
  if (!recipient || !state.ws) return;
  startOutgoingCall(conv.id, recipient.user_id, recipient.display_name || recipient.username, callType, state.ws);
}

// ── File upload ──

function showFileUpload(conversationId: string) {
  const input = document.createElement('input');
  input.type = 'file';
  input.accept = 'image/*,video/*,audio/*,.pdf,.doc,.docx,.txt,.zip';
  input.style.display = 'none';
  input.addEventListener('change', async () => {
    const file = input.files?.[0];
    if (!file) return;
    input.remove();

    // Show upload progress
    const area = document.getElementById('messages-area');
    const userId = localStorage.getItem('rocchat_user_id') || '';
    const progressDiv = document.createElement('div');
    progressDiv.className = 'message-row mine';
    progressDiv.innerHTML = `
      <div class="message-bubble">
        <div class="message-text" style="color:var(--text-tertiary)">
          📎 Uploading ${escapeHtml(file.name)}...
        </div>
      </div>
    `;
    area?.appendChild(progressDiv);
    area && (area.scrollTop = area.scrollHeight);

    try {
      const formData = new FormData();
      formData.append('file', file);
      formData.append('conversation_id', conversationId);

      const token = api.getToken();
      const res = await fetch('/api/media/upload', {
        method: 'POST',
        headers: token ? { Authorization: `Bearer ${token}` } : {},
        body: formData,
      });

      if (res.ok) {
        const data = await res.json() as { blobId: string };
        // Send file message
        const conv = state.conversations.find((c) => c.id === conversationId);
        const recipientUserId = conv?.members.find((m) => m.user_id !== userId)?.user_id;

        const fileMsg = JSON.stringify({
          type: file.type.startsWith('image/') ? 'image' : 'file',
          blobId: data.blobId,
          filename: file.name,
          mime: file.type,
          size: file.size,
        });

        if (recipientUserId) {
          const encrypted = await encryptMessage(conversationId, recipientUserId, fileMsg);
          await api.sendMessage({
            conversation_id: conversationId,
            ciphertext: encrypted.ciphertext,
            iv: encrypted.iv,
            ratchet_header: JSON.stringify(encrypted.header),
            message_type: file.type.startsWith('image/') ? 'image' : 'file',
          });
        }

        progressDiv.querySelector('.message-text')!.textContent = `📎 ${file.name}`;
      } else {
        progressDiv.querySelector('.message-text')!.textContent = '⚠️ Upload failed';
      }
    } catch {
      progressDiv.querySelector('.message-text')!.textContent = '⚠️ Upload failed';
    }
  });
  document.body.appendChild(input);
  input.click();
}

export { state as chatState };
