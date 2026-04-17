/**
 * RocChat Web — Extra Features
 *
 * Implementation bundle for the "nice-to-have" audit items:
 *
 *   - Per-message disappearing timer (one-shot override for the next send)
 *   - Voice-to-text mic button (browser SpeechRecognition)
 *   - Message forwarding (pick target conversation)
 *   - Global search (conversations + decrypted plaintext cache)
 *   - Scheduled-send management dialog
 *   - Encrypted backups (export / import of local crypto state)
 *   - Decoy (local-only, fake) conversations for plausible deniability
 *   - Custom user emoji (local-only image shortcodes)
 *   - Group moderation dialog (promote / kick / mute)
 *
 * These modules operate through the public chat API surface in chat.ts and
 * do not reach directly into its internals, so chat.ts only needs small
 * wire-up hooks rather than structural changes.
 */

import * as api from './api.js';
import { chatState } from './chat/chat.js';
import { aesGcmEncrypt, aesGcmDecrypt, pbkdf2 } from '@rocchat/shared';
import { argon2id } from 'hash-wasm';
import { getSecretString, putSecretString } from './crypto/secure-store.js';

// =============================================================================
// Toast helper (re-implemented here to avoid a circular import on chat.ts)
// =============================================================================

function toast(message: string, type: 'success' | 'error' | 'info' = 'info') {
  const el = document.createElement('div');
  el.className = `toast toast-${type}`;
  el.textContent = message;
  el.style.cssText = 'position:fixed;bottom:24px;left:50%;transform:translateX(-50%);background:var(--surface-elevated,#1c1814);color:var(--text-primary,#fff);padding:10px 18px;border:1px solid var(--border-strong,rgba(212,175,55,.3));border-radius:10px;z-index:10000;box-shadow:var(--shadow-modal,0 10px 40px rgba(0,0,0,.4));font-size:14px';
  document.body.appendChild(el);
  setTimeout(() => el.remove(), 2600);
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c] || c));
}

// =============================================================================
// Per-message expiry (one-shot)
// =============================================================================
//
// Conversation-level disappearing messages already exist. This is the
// single-message override — the user picks a timer once, the next send
// consumes it, then it clears back to "use conversation default".

let oneShotExpiresIn: number | null = null;

export function getOneShotExpiry(): number | null { return oneShotExpiresIn; }
export function consumeOneShotExpiry(): number | null {
  const v = oneShotExpiresIn;
  oneShotExpiresIn = null;
  updateOneShotIndicator();
  return v;
}

const PRESETS: { label: string; seconds: number }[] = [
  { label: 'Off', seconds: 0 },
  { label: '30 s', seconds: 30 },
  { label: '5 min', seconds: 300 },
  { label: '1 hour', seconds: 3600 },
  { label: '1 day', seconds: 86400 },
  { label: '1 week', seconds: 604800 },
];

export function openPerMessageTimerMenu(anchor: HTMLElement): void {
  document.querySelector('.per-msg-timer-menu')?.remove();
  const menu = document.createElement('div');
  menu.className = 'per-msg-timer-menu';
  menu.setAttribute('role', 'menu');
  menu.innerHTML = `
    <div class="pmt-title">This message disappears in…</div>
    ${PRESETS.map((p) => `<button class="pmt-item" data-sec="${p.seconds}">${p.label}</button>`).join('')}
  `;
  const r = anchor.getBoundingClientRect();
  menu.style.cssText = `position:fixed;left:${Math.max(12, r.left)}px;top:${Math.max(12, r.top - 260)}px;z-index:9999`;
  document.body.appendChild(menu);
  menu.querySelectorAll('.pmt-item').forEach((btn) => {
    btn.addEventListener('click', () => {
      oneShotExpiresIn = Number((btn as HTMLElement).dataset.sec) || 0;
      if (oneShotExpiresIn === 0) oneShotExpiresIn = null;
      updateOneShotIndicator();
      menu.remove();
      toast(oneShotExpiresIn
        ? `Next message disappears in ${(btn as HTMLElement).textContent}`
        : 'Timer cleared', 'info');
    });
  });
  // Add role="menuitem" to each button
  menu.querySelectorAll('.pmt-item').forEach((btn) => {
    btn.setAttribute('role', 'menuitem');
    btn.setAttribute('tabindex', '0');
  });
  // Focus first menu item
  requestAnimationFrame(() => {
    const first = menu.querySelector<HTMLElement>('.pmt-item');
    if (first) first.focus();
  });
  setTimeout(() => {
    const dismiss = (ev: MouseEvent) => {
      if (!menu.contains(ev.target as Node)) { menu.remove(); document.removeEventListener('click', dismiss, true); document.removeEventListener('keydown', onKey, true); }
    };
    const onKey = (ev: KeyboardEvent) => {
      if (ev.key === 'Escape') { menu.remove(); document.removeEventListener('click', dismiss, true); document.removeEventListener('keydown', onKey, true); }
      // Arrow key navigation
      if (ev.key === 'ArrowDown' || ev.key === 'ArrowUp') {
        ev.preventDefault();
        const items = Array.from(menu.querySelectorAll<HTMLElement>('.pmt-item'));
        const idx = items.indexOf(document.activeElement as HTMLElement);
        const next = ev.key === 'ArrowDown' ? (idx + 1) % items.length : (idx - 1 + items.length) % items.length;
        items[next]?.focus();
      }
    };
    document.addEventListener('click', dismiss, true);
    document.addEventListener('keydown', onKey, true);
  }, 0);
}

function updateOneShotIndicator(): void {
  const badge = document.getElementById('one-shot-badge');
  if (!badge) return;
  if (oneShotExpiresIn) {
    badge.textContent = `⏱ ${formatSeconds(oneShotExpiresIn)}`;
    badge.style.display = '';
  } else {
    badge.style.display = 'none';
  }
}

function formatSeconds(s: number): string {
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.round(s / 60)}m`;
  if (s < 86400) return `${Math.round(s / 3600)}h`;
  return `${Math.round(s / 86400)}d`;
}

// =============================================================================
// Voice transcription
// =============================================================================

import * as voice from './chat/voice-transcription.js';

let activeVoiceSession: voice.TranscriptionSession | null = null;

export function toggleVoiceTranscription(inputEl: HTMLTextAreaElement, btnEl: HTMLElement): void {
  if (activeVoiceSession) {
    activeVoiceSession.stop();
    activeVoiceSession = null;
    btnEl.classList.remove('recording');
    return;
  }
  if (!voice.isSupported()) {
    toast('Voice input not supported in this browser', 'error');
    return;
  }
  const existing = inputEl.value;
  const prefix = existing && !existing.endsWith(' ') ? existing + ' ' : existing;
  activeVoiceSession = voice.start(
    (partial) => { inputEl.value = prefix + partial; inputEl.dispatchEvent(new Event('input')); },
    (final)   => { inputEl.value = prefix + final + ' '; inputEl.dispatchEvent(new Event('input')); },
    (err)     => { toast(err, 'error'); activeVoiceSession?.stop(); activeVoiceSession = null; btnEl.classList.remove('recording'); },
  );
  if (activeVoiceSession) btnEl.classList.add('recording');
}

// =============================================================================
// Message forwarding
// =============================================================================

export function openForwardDialog(messageId: string, plaintext: string): void {
  closeAnyDialog();
  const dialog = document.createElement('div');
  dialog.className = 'rc-dialog-overlay';
  dialog.innerHTML = `
    <div class="rc-dialog" role="dialog" aria-label="Forward message">
      <div class="rc-dialog-header">
        <h3>Forward message</h3>
        <button class="rc-dialog-close" aria-label="Close">&times;</button>
      </div>
      <div class="rc-dialog-body">
        <input type="text" class="rc-dialog-search" placeholder="Search conversations…" />
        <div class="rc-forward-list"></div>
      </div>
    </div>`;
  document.body.appendChild(dialog);
  setupDialog(dialog);
  const list = dialog.querySelector('.rc-forward-list') as HTMLElement;
  const search = dialog.querySelector('.rc-dialog-search') as HTMLInputElement;

  function render(filter = ''): void {
    const q = filter.toLowerCase();
    list.innerHTML = chatState.conversations
      .filter((c) => !q || (c.name || '').toLowerCase().includes(q))
      .map((c) => `
        <button class="rc-forward-item" data-conv="${c.id}">
          <div class="rc-forward-name">${escapeHtml(c.name || 'Direct message')}</div>
          <div class="rc-forward-sub">${c.type || 'direct'}</div>
        </button>`).join('');
    list.querySelectorAll('.rc-forward-item').forEach((b) => {
      b.addEventListener('click', async () => {
        const targetId = (b as HTMLElement).dataset.conv!;
        await forwardTo(targetId, plaintext, messageId);
        dialog.remove();
      });
    });
  }
  render();
  search.addEventListener('input', () => render(search.value));
  dialog.querySelector('.rc-dialog-close')?.addEventListener('click', () => dialog.remove());
  dialog.addEventListener('click', (e) => { if (e.target === dialog) dialog.remove(); });
}

async function forwardTo(targetConversationId: string, plaintext: string, _originalMessageId: string): Promise<void> {
  const userId = localStorage.getItem('rocchat_user_id') || '';
  const conv = chatState.conversations.find((c) => c.id === targetConversationId);
  if (!conv) { toast('Conversation not found', 'error'); return; }
  // Prefix so the recipient sees it was forwarded.
  const body = `↪ Forwarded: ${plaintext}`;

  try {
    const recipientId = conv.members.find((m) => m.user_id !== userId)?.user_id;
    if (recipientId) {
      const { encryptMessage } = await import('./crypto/session-manager.js');
      const enc = await encryptMessage(targetConversationId, recipientId, body);
      const encAny = enc as unknown as Record<string, unknown>;
      const header = encAny.x3dh ? { ...(enc.header as object), x3dh: encAny.x3dh } : enc.header;
      await api.sendMessage({
        conversation_id: targetConversationId,
        ciphertext: enc.ciphertext,
        iv: enc.iv,
        ratchet_header: JSON.stringify(header),
        message_type: 'text',
      });
    } else {
      // Fallback — group send with plaintext in ciphertext field (already the
      // legacy path for groups in chat.ts).
      await api.sendMessage({
        conversation_id: targetConversationId,
        ciphertext: body,
        iv: '',
        ratchet_header: '',
        message_type: 'text',
      });
    }
    toast('Forwarded', 'success');
  } catch {
    toast('Forward failed', 'error');
  }
}

// =============================================================================
// Global search
// =============================================================================

interface SearchHit {
  conversationId: string;
  conversationName: string;
  messageId?: string;
  snippet: string;
}

export function openGlobalSearch(): void {
  closeAnyDialog();
  const dialog = document.createElement('div');
  dialog.className = 'rc-dialog-overlay';
  dialog.innerHTML = `
    <div class="rc-dialog rc-dialog-search-wrap" role="dialog" aria-label="Search">
      <div class="rc-dialog-header">
        <h3>Search RocChat</h3>
        <button class="rc-dialog-close" aria-label="Close">&times;</button>
      </div>
      <div class="rc-dialog-body">
        <input type="text" class="rc-dialog-search" placeholder="Search messages and chats…" autofocus />
        <div class="rc-search-hint" style="font-size:12px;color:var(--text-tertiary,#888);margin-top:6px">
          Searches decrypted messages stored on this device only.
        </div>
        <div class="rc-search-results" style="margin-top:12px;max-height:50vh;overflow:auto"></div>
      </div>
    </div>`;
  document.body.appendChild(dialog);
  setupDialog(dialog);
  const input = dialog.querySelector('.rc-dialog-search') as HTMLInputElement;
  const results = dialog.querySelector('.rc-search-results') as HTMLElement;
  input.addEventListener('input', () => {
    const q = input.value.trim();
    if (!q) { results.innerHTML = ''; return; }
    const hits = runSearch(q);
    results.innerHTML = hits.length
      ? hits.map((h) => `
          <button class="rc-search-hit" data-conv="${h.conversationId}" ${h.messageId ? `data-msg="${h.messageId}"` : ''}>
            <div class="rc-search-hit-conv">${escapeHtml(h.conversationName)}</div>
            <div class="rc-search-hit-snippet">${highlight(escapeHtml(h.snippet), q)}</div>
          </button>`).join('')
      : '<div style="padding:24px;text-align:center;color:var(--text-tertiary)">No matches</div>';
    results.querySelectorAll('.rc-search-hit').forEach((el) => {
      el.addEventListener('click', () => {
        const cid = (el as HTMLElement).dataset.conv!;
        dialog.remove();
        // Open conversation by simulating a click on its list item.
        const li = document.querySelector(`[data-conversation-id="${cid}"]`) as HTMLElement | null;
        li?.click();
      });
    });
  });
  dialog.querySelector('.rc-dialog-close')?.addEventListener('click', () => dialog.remove());
  dialog.addEventListener('click', (e) => { if (e.target === dialog) dialog.remove(); });
  // Arrow-key navigation in search results
  input.addEventListener('keydown', (e) => {
    const hits = Array.from(results.querySelectorAll<HTMLElement>('.rc-search-hit'));
    if (!hits.length) return;
    const active = results.querySelector('.rc-search-hit:focus') as HTMLElement | null;
    const idx = active ? hits.indexOf(active) : -1;
    if (e.key === 'ArrowDown') { e.preventDefault(); hits[Math.min(idx + 1, hits.length - 1)]?.focus(); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); if (idx <= 0) input.focus(); else hits[idx - 1]?.focus(); }
    else if (e.key === 'Enter' && idx === -1 && hits.length) { e.preventDefault(); hits[0]?.click(); }
  });
  input.focus();
}

function runSearch(q: string): SearchHit[] {
  const needle = q.toLowerCase();
  const hits: SearchHit[] = [];
  const seen = new Set<string>();

  // 1) Conversations by name.
  for (const c of chatState.conversations) {
    if ((c.name || '').toLowerCase().includes(needle)) {
      hits.push({
        conversationId: c.id,
        conversationName: c.name || 'Direct message',
        snippet: c.name || '',
      });
      seen.add(c.id);
    }
  }

  // 2) Messages via the local plaintext cache in localStorage.
  try {
    const raw = localStorage.getItem('rocchat_plaintext_v1');
    if (raw) {
      const cache = JSON.parse(raw) as Record<string, string>;
      for (const [messageId, plaintext] of Object.entries(cache)) {
        if (typeof plaintext !== 'string') continue;
        if (!plaintext.toLowerCase().includes(needle)) continue;
        // Resolve which conversation this message belongs to via state.messages.
        let convId = '';
        let convName = '';
        for (const [cid, list] of chatState.messages.entries()) {
          if (list.some((m) => m.id === messageId)) {
            convId = cid;
            convName = chatState.conversations.find((c) => c.id === cid)?.name || 'Direct message';
            break;
          }
        }
        if (!convId) continue;
        hits.push({ conversationId: convId, conversationName: convName, messageId, snippet: plaintext });
        if (hits.length > 100) break;
      }
    }
  } catch { /* ignore */ }

  return hits.slice(0, 100).filter((h) => h.conversationId).filter((h, i, arr) => {
    const key = `${h.conversationId}|${h.messageId || ''}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function highlight(html: string, q: string): string {
  const re = new RegExp(escapeRegex(q), 'gi');
  return html.replace(re, (m) => `<mark>${m}</mark>`);
}
function escapeRegex(s: string): string { return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

// =============================================================================
// Scheduled-send management
// =============================================================================

export async function openScheduledMessagesDialog(): Promise<void> {
  closeAnyDialog();
  const dialog = document.createElement('div');
  dialog.className = 'rc-dialog-overlay';
  dialog.innerHTML = `
    <div class="rc-dialog" role="dialog" aria-label="Scheduled messages">
      <div class="rc-dialog-header">
        <h3>Scheduled messages</h3>
        <button class="rc-dialog-close" aria-label="Close">&times;</button>
      </div>
      <div class="rc-dialog-body">
        <div class="rc-scheduled-list">Loading…</div>
      </div>
    </div>`;
  document.body.appendChild(dialog);
  setupDialog(dialog);
  dialog.querySelector('.rc-dialog-close')?.addEventListener('click', () => dialog.remove());
  dialog.addEventListener('click', (e) => { if (e.target === dialog) dialog.remove(); });
  const list = dialog.querySelector('.rc-scheduled-list') as HTMLElement;

  const res = await api.getScheduledMessages();
  if (!res.ok) { list.textContent = 'Failed to load.'; return; }
  const items = res.data;
  if (!items.length) { list.innerHTML = '<div style="padding:24px;text-align:center;color:var(--text-tertiary)">Nothing scheduled.</div>'; return; }
  list.innerHTML = items.map((it) => {
    const conv = chatState.conversations.find((c) => c.id === it.conversation_id);
    const when = new Date(it.scheduled_at * 1000).toLocaleString();
    return `
      <div class="rc-scheduled-item">
        <div>
          <div class="rc-scheduled-target">${escapeHtml(conv?.name || 'Conversation')}</div>
          <div class="rc-scheduled-when">${when}</div>
        </div>
        <button class="rc-scheduled-cancel btn-secondary" data-id="${it.id}">Cancel</button>
      </div>`;
  }).join('');
  list.querySelectorAll('.rc-scheduled-cancel').forEach((b) => {
    b.addEventListener('click', async () => {
      const id = (b as HTMLElement).dataset.id!;
      const r = await api.deleteScheduledMessage(id);
      if (r.ok) { (b.closest('.rc-scheduled-item') as HTMLElement)?.remove(); toast('Cancelled', 'success'); }
      else toast('Failed to cancel', 'error');
    });
  });
}

// =============================================================================
// Encrypted local backup
// =============================================================================
//
// Exports the on-device crypto state (identity keys, ratchet IDB, sender
// keys, plaintext cache) into a single passphrase-encrypted JSON file.
// The file never contains the raw passphrase or the server session token;
// restoration requires the user to log in again and then run "Import".

async function snapshotLocalState(): Promise<Record<string, unknown>> {
  const snapshot: Record<string, unknown> = {};

  // LocalStorage values we care about.
  const LS_KEYS = [
    'rocchat_identity_pub',
    'rocchat_identity_priv',
    'rocchat_keys',
    'rocchat_user_id',
    'rocchat_device_id',
    'rocchat_plaintext_v1',
    'rocchat_disappear_timers',
    'rocchat_recent_emoji',
    'rocchat_custom_emoji_v1',
    'rocchat_decoy_convs_v1',
  ];
  const ls: Record<string, string> = {};
  for (const k of LS_KEYS) {
    // Secret keys live in the encrypted IDB store; fall back to LS for legacy
    const v = (await getSecretString(k)) ?? localStorage.getItem(k);
    if (v !== null) ls[k] = v;
  }
  snapshot.localStorage = ls;

  // IndexedDB snapshots (ratchet states + sender keys).
  snapshot.indexedDB = {
    ratchet: await dumpObjectStore('rocchat_sessions', 'ratchet_sessions').catch(() => []),
    senderKeys: await dumpObjectStore('rocchat_group_keys', 'sender_keys').catch(() => []),
    messageQueue: await dumpObjectStore('rocchat_message_queue', 'queue').catch(() => []),
  };
  snapshot.exported_at = Date.now();
  snapshot.schema_version = 1;
  return snapshot;
}

function dumpObjectStore(dbName: string, storeName: string): Promise<unknown[]> {
  return new Promise((resolve, reject) => {
    const openReq = indexedDB.open(dbName);
    openReq.onerror = () => reject(openReq.error);
    openReq.onsuccess = () => {
      const db = openReq.result;
      if (!db.objectStoreNames.contains(storeName)) { db.close(); resolve([]); return; }
      const tx = db.transaction(storeName, 'readonly');
      const store = tx.objectStore(storeName);
      const all = store.getAll();
      all.onsuccess = () => { db.close(); resolve(all.result); };
      all.onerror = () => { db.close(); reject(all.error); };
    };
  });
}

function restoreObjectStore(dbName: string, storeName: string, rows: unknown[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const openReq = indexedDB.open(dbName);
    openReq.onerror = () => reject(openReq.error);
    openReq.onsuccess = () => {
      const db = openReq.result;
      if (!db.objectStoreNames.contains(storeName)) { db.close(); resolve(); return; }
      const tx = db.transaction(storeName, 'readwrite');
      const store = tx.objectStore(storeName);
      for (const r of rows) store.put(r);
      tx.oncomplete = () => { db.close(); resolve(); };
      tx.onerror = () => { db.close(); reject(tx.error); };
    };
  });
}

export async function exportEncryptedBackup(passphrase: string): Promise<void> {
  if (passphrase.length < 12) { toast('Passphrase must be at least 12 characters', 'error'); return; }
  const snapshot = await snapshotLocalState();
  const json = new TextEncoder().encode(JSON.stringify(snapshot));
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const keyHex = await argon2id({
    password: passphrase,
    salt,
    parallelism: 1,
    iterations: 3,
    memorySize: 65536, // 64 MiB
    hashLength: 32,
    outputType: 'hex',
  });
  const key = new Uint8Array(keyHex.match(/.{2}/g)!.map(b => parseInt(b, 16)));
  const { ciphertext, iv, tag } = await aesGcmEncrypt(json, key);
  const payload = {
    magic: 'ROCCHAT-BACKUP-2',
    kdf: 'argon2id',
    salt: Array.from(salt),
    iv: Array.from(iv),
    ciphertext: Array.from(new Uint8Array(ciphertext)),
    tag: Array.from(tag),
    argon2: { parallelism: 1, iterations: 3, memorySize: 65536 },
  };
  const blob = new Blob([JSON.stringify(payload)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `rocchat-backup-${new Date().toISOString().slice(0, 10)}.json`;
  a.click();
  URL.revokeObjectURL(url);
  toast('Backup downloaded', 'success');
}

export async function importEncryptedBackup(file: File, passphrase: string): Promise<void> {
  try {
    const text = await file.text();
    const payload = JSON.parse(text) as {
      magic: string;
      kdf?: string;
      salt: number[];
      iv: number[];
      ciphertext: number[];
      tag: number[];
      iterations?: number;
      argon2?: { parallelism: number; iterations: number; memorySize: number };
    };
    if (payload.magic !== 'ROCCHAT-BACKUP-1' && payload.magic !== 'ROCCHAT-BACKUP-2') { toast('Not a RocChat backup file', 'error'); return; }
    const salt = new Uint8Array(payload.salt);
    const iv = new Uint8Array(payload.iv);
    const ct = new Uint8Array(payload.ciphertext);
    const tag = new Uint8Array(payload.tag);
    let key: Uint8Array;
    if (payload.magic === 'ROCCHAT-BACKUP-2' && payload.kdf === 'argon2id' && payload.argon2) {
      const keyHex = await argon2id({
        password: passphrase,
        salt,
        parallelism: payload.argon2.parallelism,
        iterations: payload.argon2.iterations,
        memorySize: payload.argon2.memorySize,
        hashLength: 32,
        outputType: 'hex',
      });
      key = new Uint8Array(keyHex.match(/.{2}/g)!.map(b => parseInt(b, 16)));
    } else {
      key = await pbkdf2(new TextEncoder().encode(passphrase), salt, payload.iterations || 310_000, 32);
    }
    const plain = await aesGcmDecrypt(ct, key, iv, tag);
    const snapshot = JSON.parse(new TextDecoder().decode(plain)) as {
      localStorage: Record<string, string>;
      indexedDB: { ratchet: unknown[]; senderKeys: unknown[]; messageQueue: unknown[] };
    };
    // Audit #8: Only restore whitelisted keys; route secrets through secure-store
    const SECRET_KEYS = new Set(['rocchat_identity_priv', 'rocchat_keys', 'rocchat_spk_priv']);
    const ALLOWED_KEYS = new Set([
      'rocchat_identity_pub', 'rocchat_identity_priv', 'rocchat_keys', 'rocchat_spk_priv',
      'rocchat_user_id', 'rocchat_device_id', 'rocchat_plaintext_v1',
      'rocchat_disappear_timers', 'rocchat_recent_emoji',
      'rocchat_custom_emoji_v1', 'rocchat_decoy_convs_v1',
    ]);
    for (const [k, v] of Object.entries(snapshot.localStorage)) {
      if (!ALLOWED_KEYS.has(k)) continue;
      if (SECRET_KEYS.has(k)) {
        await putSecretString(k, v);
      } else {
        localStorage.setItem(k, v);
      }
    }
    await restoreObjectStore('rocchat_sessions', 'ratchet_sessions', snapshot.indexedDB.ratchet);
    await restoreObjectStore('rocchat_group_keys', 'sender_keys', snapshot.indexedDB.senderKeys);
    await restoreObjectStore('rocchat_message_queue', 'queue', snapshot.indexedDB.messageQueue);
    toast('Backup restored — reloading', 'success');
    setTimeout(() => location.reload(), 1200);
  } catch {
    toast('Failed to decrypt backup — wrong passphrase?', 'error');
  }
}

export function openBackupDialog(): void {
  closeAnyDialog();
  const dialog = document.createElement('div');
  dialog.className = 'rc-dialog-overlay';
  dialog.innerHTML = `
    <div class="rc-dialog" role="dialog" aria-label="Encrypted backup">
      <div class="rc-dialog-header">
        <h3>Encrypted backup</h3>
        <button class="rc-dialog-close" aria-label="Close">&times;</button>
      </div>
      <div class="rc-dialog-body">
        <p style="font-size:14px;color:var(--text-secondary)">
          Export or restore your on-device keys, messages, and settings.
          The backup file is encrypted with a passphrase of your choice
          (Argon2id + AES-GCM). Losing the passphrase means losing the backup.
        </p>
        <label style="display:block;margin-top:12px">Passphrase
          <input type="password" class="rc-backup-pass" minlength="12" autocomplete="new-password" style="width:100%;margin-top:4px" />
        </label>
        <div style="display:flex;gap:8px;margin-top:14px;flex-wrap:wrap">
          <button class="btn-primary rc-backup-export">Export</button>
          <label class="btn-secondary" style="cursor:pointer">
            Import… <input type="file" class="rc-backup-file" accept="application/json" style="display:none" />
          </label>
        </div>
      </div>
    </div>`;
  document.body.appendChild(dialog);
  setupDialog(dialog);
  const pass = dialog.querySelector('.rc-backup-pass') as HTMLInputElement;
  dialog.querySelector('.rc-backup-export')?.addEventListener('click', () => exportEncryptedBackup(pass.value));
  dialog.querySelector('.rc-backup-file')?.addEventListener('change', (e) => {
    const f = (e.target as HTMLInputElement).files?.[0];
    if (f) importEncryptedBackup(f, pass.value);
  });
  dialog.querySelector('.rc-dialog-close')?.addEventListener('click', () => dialog.remove());
  dialog.addEventListener('click', (e) => { if (e.target === dialog) dialog.remove(); });
}

// =============================================================================
// Decoy conversations (local-only plausible-deniability placeholders)
// =============================================================================
//
// A decoy conversation is fully synthetic — it exists only in localStorage
// and is never sent to the backend. It lets a user present a "clean" chat
// history under coercion without exposing real conversations.
//
// Decoys show up in the sidebar alongside real chats but are marked with
// a visible (to the user, in settings) flag and never attempt any network
// I/O. When opened, they render a fixed, edit-locked message list.

export interface DecoyMessage {
  sender_name: string;
  text: string;
  offset_minutes: number;
}
export interface DecoyConversation {
  id: string;              // prefixed with "decoy_"
  name: string;
  messages: DecoyMessage[];
  created_at: number;
}

const DECOY_KEY = 'rocchat_decoy_convs_v1';

export function listDecoys(): DecoyConversation[] {
  try { return JSON.parse(localStorage.getItem(DECOY_KEY) || '[]'); } catch { return []; }
}

export function saveDecoys(list: DecoyConversation[]): void {
  localStorage.setItem(DECOY_KEY, JSON.stringify(list));
}

export function addDecoy(name: string, messages: DecoyMessage[]): DecoyConversation {
  const d: DecoyConversation = {
    id: 'decoy_' + crypto.randomUUID(),
    name,
    messages,
    created_at: Math.floor(Date.now() / 1000),
  };
  const list = listDecoys();
  list.push(d);
  saveDecoys(list);
  return d;
}

export function removeDecoy(id: string): void {
  saveDecoys(listDecoys().filter((d) => d.id !== id));
}

export function openDecoyManager(): void {
  closeAnyDialog();
  const dialog = document.createElement('div');
  dialog.className = 'rc-dialog-overlay';
  const list = listDecoys();
  dialog.innerHTML = `
    <div class="rc-dialog" role="dialog" aria-label="Decoy conversations">
      <div class="rc-dialog-header">
        <h3>Decoy conversations</h3>
        <button class="rc-dialog-close" aria-label="Close">&times;</button>
      </div>
      <div class="rc-dialog-body">
        <p style="font-size:14px;color:var(--text-secondary)">
          Decoys are fake conversations stored only on this device. They
          never touch the server, but look real in the sidebar.
        </p>
        <div class="rc-decoy-list">
          ${list.length ? list.map((d) => `
            <div class="rc-decoy-item">
              <div><strong>${escapeHtml(d.name)}</strong> <span style="color:var(--text-tertiary);font-size:12px">(${d.messages.length} messages)</span></div>
              <button class="btn-secondary rc-decoy-delete" data-id="${d.id}">Delete</button>
            </div>`).join('') : '<div style="color:var(--text-tertiary);padding:12px">No decoys yet.</div>'}
        </div>
        <hr style="border-color:var(--border-weak);margin:14px 0" />
        <h4 style="margin:0 0 8px 0">Add a decoy</h4>
        <label style="display:block;margin-bottom:6px">Name
          <input type="text" class="rc-decoy-name" style="width:100%;margin-top:4px" />
        </label>
        <label style="display:block;margin-bottom:6px">Messages (one per line, format: <code>sender|text</code>)
          <textarea class="rc-decoy-messages" rows="6" style="width:100%;margin-top:4px;font-family:var(--font-mono)" placeholder="Alice|Hey, how are you?&#10;You|Good, you?"></textarea>
        </label>
        <button class="btn-primary rc-decoy-add">Add decoy</button>
      </div>
    </div>`;
  document.body.appendChild(dialog);
  setupDialog(dialog);
  dialog.querySelector('.rc-dialog-close')?.addEventListener('click', () => dialog.remove());
  dialog.addEventListener('click', (e) => { if (e.target === dialog) dialog.remove(); });
  dialog.querySelectorAll('.rc-decoy-delete').forEach((b) => {
    b.addEventListener('click', () => {
      removeDecoy((b as HTMLElement).dataset.id!);
      dialog.remove(); openDecoyManager();
    });
  });
  dialog.querySelector('.rc-decoy-add')?.addEventListener('click', () => {
    const name = (dialog.querySelector('.rc-decoy-name') as HTMLInputElement).value.trim();
    const raw = (dialog.querySelector('.rc-decoy-messages') as HTMLTextAreaElement).value.trim();
    if (!name || !raw) { toast('Name and at least one message required', 'error'); return; }
    const messages = raw.split('\n').map((line, i) => {
      const [sender, ...rest] = line.split('|');
      return { sender_name: sender.trim() || 'Contact', text: rest.join('|').trim() || line.trim(), offset_minutes: -i * 3 };
    });
    addDecoy(name, messages);
    dialog.remove(); openDecoyManager();
  });
}

// =============================================================================
// Custom user emoji
// =============================================================================
//
// Small, local-only custom emoji: the user uploads images, they're stored as
// data URLs in localStorage (capped at ~1 MB each, 64 total), and they appear
// in the emoji picker under a "Custom" tab. Sent messages include the image
// as an `[[emoji:shortcode]]` token that recipients render using the same
// local library (no automatic sync across devices — users can export via
// encrypted backup).

export interface CustomEmoji {
  shortcode: string; // without colons, e.g. "partyparrot"
  data_url: string;  // image
}
const EMOJI_KEY = 'rocchat_custom_emoji_v1';
const MAX_EMOJI = 64;
const MAX_EMOJI_BYTES = 1024 * 1024;

export function listCustomEmoji(): CustomEmoji[] {
  try { return JSON.parse(localStorage.getItem(EMOJI_KEY) || '[]'); } catch { return []; }
}
export function saveCustomEmoji(list: CustomEmoji[]): void {
  localStorage.setItem(EMOJI_KEY, JSON.stringify(list));
}

export async function addCustomEmoji(shortcode: string, file: File): Promise<void> {
  const s = shortcode.replace(/[^a-z0-9_]/gi, '').toLowerCase();
  if (!s) { toast('Invalid shortcode', 'error'); return; }
  if (file.size > MAX_EMOJI_BYTES) { toast('Image too large (max 1 MB)', 'error'); return; }
  const data_url = await new Promise<string>((res, rej) => {
    const fr = new FileReader();
    fr.onload = () => res(fr.result as string);
    fr.onerror = () => rej(fr.error);
    fr.readAsDataURL(file);
  });
  if (!/^data:image\/(png|jpeg|gif|webp|svg\+xml);base64,/.test(data_url)) {
    toast('Invalid image format', 'error'); return;
  }
  const list = listCustomEmoji().filter((e) => e.shortcode !== s);
  list.push({ shortcode: s, data_url });
  while (list.length > MAX_EMOJI) list.shift();
  saveCustomEmoji(list);
  toast(`Added :${s}:`, 'success');
}

/**
 * Replace `:shortcode:` tokens in `text` with inline <img> tags. Pass
 * `escape=true` when the input is untrusted (e.g. from an incoming message).
 */
export function renderCustomEmoji(text: string, escape = true): string {
  const list = listCustomEmoji();
  if (!list.length) return escape ? escapeHtml(text) : text;
  const byShort = new Map(list.map((e) => [e.shortcode, e.data_url]));
  const out = (escape ? escapeHtml(text) : text).replace(/:([a-z0-9_]{2,32}):/gi, (m, code) => {
    const url = byShort.get(code.toLowerCase());
    if (!url || !/^data:image\/(png|jpeg|gif|webp|svg\+xml);base64,[A-Za-z0-9+/=]+$/.test(url)) return m;
    return `<img class="custom-emoji" src="${escapeHtml(url)}" alt=":${code}:" title=":${code}:" style="width:1.3em;height:1.3em;vertical-align:-0.2em" />`;
  });
  return out;
}

export function openCustomEmojiManager(): void {
  closeAnyDialog();
  const dialog = document.createElement('div');
  dialog.className = 'rc-dialog-overlay';
  const list = listCustomEmoji();
  dialog.innerHTML = `
    <div class="rc-dialog" role="dialog" aria-label="Custom emoji">
      <div class="rc-dialog-header">
        <h3>Custom emoji</h3>
        <button class="rc-dialog-close" aria-label="Close">&times;</button>
      </div>
      <div class="rc-dialog-body">
        <p style="font-size:14px;color:var(--text-secondary)">
          Upload small images (&lt; 1 MB) and reference them in messages as
          <code>:shortcode:</code>. Stored locally on this device only.
        </p>
        <div style="display:flex;gap:6px;margin-top:10px">
          <input type="text" class="rc-emoji-code" placeholder="shortcode (letters, digits, _)" style="flex:1" />
          <label class="btn-secondary" style="cursor:pointer">
            Upload… <input type="file" class="rc-emoji-file" accept="image/*" style="display:none" />
          </label>
        </div>
        <div class="rc-emoji-grid" style="display:grid;grid-template-columns:repeat(auto-fill,minmax(70px,1fr));gap:8px;margin-top:14px">
          ${list.map((e) => `
            <div class="rc-emoji-tile" style="text-align:center">
              <img src="${e.data_url}" alt=":${e.shortcode}:" style="width:40px;height:40px;object-fit:contain;border-radius:6px;border:1px solid var(--border-weak)" />
              <div style="font-size:11px;color:var(--text-secondary);word-break:break-all">:${escapeHtml(e.shortcode)}:</div>
              <button class="rc-emoji-del" data-code="${escapeHtml(e.shortcode)}" style="font-size:11px;background:transparent;border:0;color:var(--text-tertiary);cursor:pointer">Remove</button>
            </div>`).join('')}
        </div>
      </div>
    </div>`;
  document.body.appendChild(dialog);
  setupDialog(dialog);
  dialog.querySelector('.rc-dialog-close')?.addEventListener('click', () => dialog.remove());
  dialog.addEventListener('click', (e) => { if (e.target === dialog) dialog.remove(); });
  dialog.querySelector('.rc-emoji-file')?.addEventListener('change', async (e) => {
    const file = (e.target as HTMLInputElement).files?.[0];
    const code = (dialog.querySelector('.rc-emoji-code') as HTMLInputElement).value;
    if (!file || !code) { toast('Choose a shortcode and a file', 'error'); return; }
    await addCustomEmoji(code, file);
    dialog.remove(); openCustomEmojiManager();
  });
  dialog.querySelectorAll('.rc-emoji-del').forEach((b) => {
    b.addEventListener('click', () => {
      const code = (b as HTMLElement).dataset.code!;
      saveCustomEmoji(listCustomEmoji().filter((x) => x.shortcode !== code));
      dialog.remove(); openCustomEmojiManager();
    });
  });
}

// =============================================================================
// Group moderation dialog
// =============================================================================

export async function openGroupAdminDialog(conversationId: string): Promise<void> {
  closeAnyDialog();
  const dialog = document.createElement('div');
  dialog.className = 'rc-dialog-overlay';
  dialog.innerHTML = `
    <div class="rc-dialog" role="dialog" aria-label="Group admin">
      <div class="rc-dialog-header">
        <h3>Group members</h3>
        <button class="rc-dialog-close" aria-label="Close">&times;</button>
      </div>
      <div class="rc-dialog-body">
        <div class="rc-group-members">Loading…</div>
      </div>
    </div>`;
  document.body.appendChild(dialog);
  setupDialog(dialog);
  dialog.querySelector('.rc-dialog-close')?.addEventListener('click', () => dialog.remove());
  dialog.addEventListener('click', (e) => { if (e.target === dialog) dialog.remove(); });
  const box = dialog.querySelector('.rc-group-members') as HTMLElement;
  const res = await api.getGroupMembers(conversationId);
  if (!res.ok) { box.textContent = 'Failed to load members.'; return; }
  const me = localStorage.getItem('rocchat_user_id') || '';
  const myRole = res.data.members.find((m) => m.user_id === me)?.role || 'member';
  box.innerHTML = res.data.members.map((m) => `
    <div class="rc-group-member" data-uid="${m.user_id}">
      <div>
        <div class="rc-gm-name">${escapeHtml(m.username || m.user_id)}</div>
        <div class="rc-gm-role">${m.role}${m.muted_until && m.muted_until > Math.floor(Date.now() / 1000) ? ' · muted' : ''}</div>
      </div>
      <div class="rc-gm-actions">
        ${canModerate(myRole, m.role) ? `
          <select class="rc-gm-role-select">
            ${['admin', 'moderator', 'member'].map((r) => `<option value="${r}" ${r === m.role ? 'selected' : ''}>${r}</option>`).join('')}
          </select>
          <button class="btn-secondary rc-gm-mute">Mute 1h</button>
          <button class="btn-secondary rc-gm-unmute">Unmute</button>
          <button class="btn-secondary rc-gm-kick" style="color:var(--danger,#e66)">Kick</button>
        ` : ''}
      </div>
    </div>`).join('');

  box.querySelectorAll('.rc-group-member').forEach((row) => {
    const uid = (row as HTMLElement).dataset.uid!;
    (row.querySelector('.rc-gm-role-select') as HTMLSelectElement | null)?.addEventListener('change', async (e) => {
      const role = (e.target as HTMLSelectElement).value as api.GroupMember['role'];
      const r = await api.promoteGroupMember(conversationId, uid, role);
      toast(r.ok ? 'Role updated' : 'Failed', r.ok ? 'success' : 'error');
    });
    row.querySelector('.rc-gm-mute')?.addEventListener('click', async () => {
      const until = Math.floor(Date.now() / 1000) + 3600;
      const r = await api.muteGroupMember(conversationId, uid, until);
      toast(r.ok ? 'Muted for 1 hour' : 'Failed', r.ok ? 'success' : 'error');
    });
    row.querySelector('.rc-gm-unmute')?.addEventListener('click', async () => {
      const r = await api.muteGroupMember(conversationId, uid, 0);
      toast(r.ok ? 'Unmuted' : 'Failed', r.ok ? 'success' : 'error');
    });
    row.querySelector('.rc-gm-kick')?.addEventListener('click', async () => {
      if (!confirm('Kick this member?')) return;
      const r = await api.kickGroupMember(conversationId, uid);
      if (r.ok) { (row as HTMLElement).remove(); toast('Kicked', 'success'); }
      else toast('Failed', 'error');
    });
  });
}

function canModerate(actor: api.GroupMember['role'], target: api.GroupMember['role']): boolean {
  const rank = { owner: 4, admin: 3, moderator: 2, member: 1 } as const;
  return rank[actor] > rank[target];
}

// =============================================================================
// Shared dialog helper
// =============================================================================

let _previousFocus: HTMLElement | null = null;

function closeAnyDialog(): void {
  document.querySelectorAll('.rc-dialog-overlay').forEach((el) => el.remove());
  if (_previousFocus && document.contains(_previousFocus)) {
    try { _previousFocus.focus(); } catch {}
  }
  _previousFocus = null;
}

/** Wire focus-trap, Esc-to-close, first-focus-on-open, focus-restore on a dialog overlay */
function setupDialog(overlay: HTMLElement): void {
  _previousFocus = document.activeElement as HTMLElement | null;

  // Esc to close
  const onKey = (e: KeyboardEvent) => {
    if (e.key === 'Escape') { e.stopPropagation(); overlay.remove(); restoreFocus(); }
    // Focus trap — Tab / Shift+Tab
    if (e.key === 'Tab') {
      const focusable = overlay.querySelectorAll<HTMLElement>(
        'a[href],button:not([disabled]),input:not([disabled]),textarea:not([disabled]),select:not([disabled]),[tabindex]:not([tabindex="-1"])',
      );
      if (!focusable.length) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
    }
  };
  overlay.addEventListener('keydown', onKey);

  // First focus: find autofocus input, or first focusable, or the dialog itself
  requestAnimationFrame(() => {
    const af = overlay.querySelector<HTMLElement>('[autofocus]');
    if (af) { af.focus(); return; }
    const first = overlay.querySelector<HTMLElement>(
      'input:not([disabled]),button:not([disabled]),textarea:not([disabled]),[tabindex]:not([tabindex="-1"])',
    );
    if (first) first.focus();
    else { const dlg = overlay.querySelector<HTMLElement>('.rc-dialog'); if (dlg) { dlg.tabIndex = -1; dlg.focus(); } }
  });

  function restoreFocus() {
    if (_previousFocus && document.contains(_previousFocus)) {
      try { _previousFocus.focus(); } catch {}
    }
    _previousFocus = null;
  }
}
