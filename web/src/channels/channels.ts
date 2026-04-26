/**
 * RocChat — Channels & Communities Tab
 * Discover and subscribe to public broadcast channels.
 * Admin features: schedule posts, pin posts, view analytics.
 */
import * as api from '../api.js';
import { escapeHtml, parseHTML } from '../utils.js';
import { toBase64, fromBase64, decode } from '@rocchat/shared';

function tryDecodePost(b64: string): string {
  try {
    const bytes = fromBase64(b64);
    const text = decode(bytes);
    // If decode produced replacement chars or control bytes, treat as encrypted
    if (/[\x00-\x08\x0B\x0C\x0E-\x1F\uFFFD]/.test(text)) return '';
    return text;
  } catch {
    return '';
  }
}

interface Channel {
  id: string;
  name: string;
  description: string;
  subscriber_count: number;
  tags: string;
  avatar_url: string | null;
  my_role?: string | null;
  pinned_post_id?: string | null;
  topic?: string;
  created_by?: string;
}

interface Community {
  id: string;
  name: string;
  description: string;
  member_count: number;
  avatar_url: string | null;
}

let currentView: 'discover' | 'detail' = 'discover';
let activeChannel: Channel | null = null;

export function renderChannels(container: HTMLElement) {
  currentView = 'discover';
  activeChannel = null;
  renderDiscoverView(container);
}

function renderDiscoverView(container: HTMLElement) {
  container.replaceChildren(parseHTML(`
    <div class="channels-view" style="max-width:720px;margin:0 auto;padding:var(--sp-6)">
      <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:var(--sp-4)">
        <h2 style="margin:0;font-size:var(--fs-2xl);font-weight:700">Channels</h2>
        <button id="create-channel-btn" class="btn-primary" style="padding:8px 16px;font-size:var(--fs-sm)">
          + New Channel
        </button>
      </div>

      <div style="display:flex;gap:var(--sp-2);margin-bottom:var(--sp-4)">
        <input id="channel-search" type="text" placeholder="Search channels..."
          style="flex:1;padding:10px 14px;border-radius:var(--radius-lg);border:1px solid var(--border-norm);background:var(--bg-input);color:var(--text-primary);font-size:var(--fs-base)" />
        <button id="channel-search-btn" class="btn-secondary" style="padding:8px 16px">Search</button>
      </div>

      <div id="channels-list" style="display:flex;flex-direction:column;gap:var(--sp-3)">
        <div style="text-align:center;padding:var(--sp-8);color:var(--text-secondary)">Loading channels...</div>
      </div>

      <div style="display:flex;align-items:center;justify-content:space-between;margin-top:var(--sp-6)">
        <h3 style="margin:0;font-size:var(--fs-xl);font-weight:600">Communities</h3>
        <button id="create-community-btn" class="btn-secondary" style="padding:8px 16px;font-size:var(--fs-sm)">+ New Community</button>
      </div>
      <div id="communities-list" style="display:flex;flex-direction:column;gap:var(--sp-3);margin-top:var(--sp-3)">
        <div style="text-align:center;padding:var(--sp-4);color:var(--text-secondary)">Loading communities...</div>
      </div>
    </div>
  `));

  loadChannels();
  loadCommunities();

  document.getElementById('channel-search-btn')?.addEventListener('click', () => {
    const q = (document.getElementById('channel-search') as HTMLInputElement).value.trim();
    loadChannels(q);
  });

  document.getElementById('channel-search')?.addEventListener('keydown', (e) => {
    if ((e as KeyboardEvent).key === 'Enter') {
      const q = (document.getElementById('channel-search') as HTMLInputElement).value.trim();
      loadChannels(q);
    }
  });

  document.getElementById('create-channel-btn')?.addEventListener('click', () => {
    showCreateChannelDialog(container);
  });

  document.getElementById('create-community-btn')?.addEventListener('click', () => {
    showCreateCommunityDialog(container);
  });
}

async function loadChannels(query = '') {
  const list = document.getElementById('channels-list');
  if (!list) return;

  try {
    const params = new URLSearchParams();
    if (query) params.set('q', query);
    const res = await api.req<{ channels: Channel[] }>(`/channels/discover?${params}`, { method: 'GET' });
    if (!res.ok || !res.data?.channels?.length) {
      list.replaceChildren(parseHTML(`<div style="text-align:center;padding:var(--sp-6);color:var(--text-secondary)">
        ${query ? 'No channels found for "' + query + '"' : 'No public channels yet. Create one!'}
      </div>`));
      return;
    }

    list.replaceChildren(parseHTML(res.data.channels.map((ch: Channel) => `
      <div class="channel-card" data-id="${ch.id}" style="padding:var(--sp-4);border-radius:var(--radius-lg);border:1px solid var(--border-weak);background:var(--bg-card);cursor:pointer;transition:background var(--duration-fast) var(--ease-out)">
        <div style="display:flex;align-items:center;gap:var(--sp-3)">
          <div style="width:40px;height:40px;border-radius:var(--radius-md);background:var(--primary-bg);display:flex;align-items:center;justify-content:center;font-size:18px;color:var(--roc-gold)">📢</div>
          <div style="flex:1;min-width:0">
            <div style="font-weight:600;font-size:var(--fs-base)">${ch.name}</div>
            <div style="font-size:var(--fs-sm);color:var(--text-secondary);overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${ch.description || 'No description'}</div>
          </div>
          <div style="text-align:right">
            <div style="font-size:var(--fs-xs);color:var(--text-tertiary)">${ch.subscriber_count} subscribers</div>
            ${ch.tags ? `<div style="font-size:var(--fs-xs);color:var(--roc-gold);margin-top:2px">${ch.tags.split(',').slice(0, 3).map((t: string) => '#' + t.trim()).join(' ')}</div>` : ''}
          </div>
        </div>
      </div>
    `).join('')));

    // Click to open channel detail
    list.querySelectorAll('.channel-card').forEach(card => {
      card.addEventListener('click', async () => {
        const id = (card as HTMLElement).dataset.id!;
        openChannelDetail(id, list.closest('.channels-view')!.parentElement!);
      });
    });
  } catch {
    list.replaceChildren(parseHTML(`<div style="color:var(--danger);text-align:center;padding:var(--sp-4)">Failed to load channels</div>`));
  }
}

async function openChannelDetail(channelId: string, container: HTMLElement) {
  const res = await api.req<{ channel: Channel }>(`/channels/${channelId}`, { method: 'GET' });
  if (!res.ok || !res.data?.channel) return;
  activeChannel = res.data.channel;
  currentView = 'detail';
  renderChannelDetail(container);
}

function renderChannelDetail(container: HTMLElement) {
  const ch = activeChannel!;
  const isAdmin = ch.my_role === 'owner' || ch.my_role === 'admin';
  const isSubscribed = !!ch.my_role;

  container.replaceChildren(parseHTML(`
    <div class="channels-view" style="max-width:720px;margin:0 auto;padding:var(--sp-6)">
      <button id="back-to-discover" class="btn-secondary" style="margin-bottom:var(--sp-4);padding:6px 14px;font-size:var(--fs-sm)">← Back</button>

      <div style="display:flex;align-items:center;gap:var(--sp-4);margin-bottom:var(--sp-4)">
        <div style="width:56px;height:56px;border-radius:var(--radius-lg);background:var(--primary-bg);display:flex;align-items:center;justify-content:center;font-size:28px;color:var(--roc-gold)">📢</div>
        <div style="flex:1">
          <h2 style="margin:0;font-size:var(--fs-2xl);font-weight:700">${ch.name}</h2>
          <div style="font-size:var(--fs-sm);color:var(--text-secondary)">${ch.description || ''}</div>
          <div style="font-size:var(--fs-xs);color:var(--text-tertiary);margin-top:4px">${ch.subscriber_count} subscribers${ch.tags ? ' · ' + ch.tags.split(',').map((t: string) => '#' + t.trim()).join(' ') : ''}</div>
        </div>
        ${isSubscribed
          ? `<button id="unsub-btn" class="btn-secondary" style="padding:8px 16px;font-size:var(--fs-sm)">Unsubscribe</button>`
          : `<button id="sub-btn" class="btn-primary" style="padding:8px 16px;font-size:var(--fs-sm)">Subscribe</button>`
        }
      </div>

      ${ch.pinned_post_id ? `
        <div id="pinned-banner" style="padding:var(--sp-3);background:rgba(212,175,55,0.08);border:1px solid var(--roc-gold);border-radius:var(--radius-md);margin-bottom:var(--sp-4);display:flex;align-items:center;gap:var(--sp-2)">
          <span>📌</span>
          <span style="flex:1;font-size:var(--fs-sm);color:var(--text-secondary)">Pinned post: ${ch.pinned_post_id.slice(0, 8)}...</span>
          ${isAdmin ? `<button class="btn-secondary" id="unpin-btn" style="padding:4px 10px;font-size:var(--fs-xs)">Unpin</button>` : ''}
        </div>
      ` : ''}

      ${isAdmin ? `
        <div style="display:flex;gap:var(--sp-2);margin-bottom:var(--sp-4);flex-wrap:wrap">
          <button id="admin-post-btn" class="btn-primary" style="padding:8px 16px;font-size:var(--fs-sm)">📝 New Post</button>
          <button id="admin-schedule-btn" class="btn-secondary" style="padding:8px 16px;font-size:var(--fs-sm)">🕐 Schedule Post</button>
          <button id="admin-scheduled-btn" class="btn-secondary" style="padding:8px 16px;font-size:var(--fs-sm)">📋 Scheduled (${0})</button>
          <button id="admin-analytics-btn" class="btn-secondary" style="padding:8px 16px;font-size:var(--fs-sm)">📊 Analytics</button>
        </div>
      ` : ''}

      <div id="channel-posts" style="display:flex;flex-direction:column;gap:var(--sp-3)">
        <div style="text-align:center;padding:var(--sp-6);color:var(--text-secondary)">Loading posts...</div>
      </div>
    </div>
  `));

  // Back button
  document.getElementById('back-to-discover')?.addEventListener('click', () => {
    activeChannel = null;
    currentView = 'discover';
    renderDiscoverView(container);
  });

  // Subscribe/unsubscribe
  document.getElementById('sub-btn')?.addEventListener('click', async () => {
    const r = await api.req(`/channels/${ch.id}/subscribe`, { method: 'POST' });
    if (r.ok) openChannelDetail(ch.id, container);
  });
  document.getElementById('unsub-btn')?.addEventListener('click', async () => {
    const r = await api.req(`/channels/${ch.id}/subscribe`, { method: 'DELETE' });
    if (r.ok) openChannelDetail(ch.id, container);
  });

  // Unpin
  document.getElementById('unpin-btn')?.addEventListener('click', async () => {
    await api.req(`/channels/${ch.id}/pin`, { method: 'DELETE' });
    openChannelDetail(ch.id, container);
  });

  // Admin actions
  if (isAdmin) {
    document.getElementById('admin-post-btn')?.addEventListener('click', () => showPostDialog(ch.id, false, container));
    document.getElementById('admin-schedule-btn')?.addEventListener('click', () => showPostDialog(ch.id, true, container));
    document.getElementById('admin-scheduled-btn')?.addEventListener('click', () => showScheduledPosts(ch.id));
    document.getElementById('admin-analytics-btn')?.addEventListener('click', () => showAnalytics(ch.id));

    // Load scheduled count
    api.req<{ posts: unknown[] }>(`/channels/${ch.id}/scheduled`, { method: 'GET' }).then(r => {
      const btn = document.getElementById('admin-scheduled-btn');
      if (btn && r.data?.posts) btn.textContent = `📋 Scheduled (${r.data.posts.length})`;
    });
  }

  loadChannelPosts(ch.id, isAdmin);
}

async function loadChannelPosts(channelId: string, isAdmin: boolean) {
  const postsEl = document.getElementById('channel-posts');
  if (!postsEl) return;

  try {
    // Load recent messages for this channel
    const res = await api.req<{ messages: Array<{ id: string; sender_id: string; ciphertext: string; message_type: string; created_at: number }> }>(`/messages/${channelId}?limit=50`, { method: 'GET' });
    if (!res.ok || !res.data?.messages?.length) {
      postsEl.replaceChildren(parseHTML(`<div style="text-align:center;padding:var(--sp-6);color:var(--text-secondary)">No posts yet</div>`));
      return;
    }

    postsEl.replaceChildren(parseHTML(res.data.messages.map(msg => `
      <div class="channel-post" data-id="${msg.id}" style="padding:var(--sp-4);border-radius:var(--radius-lg);border:1px solid var(--border-weak);background:var(--bg-card)">
        <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:var(--sp-2)">
          <span style="font-size:var(--fs-xs);color:var(--text-tertiary)">${new Date(msg.created_at * 1000).toLocaleString()}</span>
          ${isAdmin ? `<div style="display:flex;gap:4px">
            <button class="pin-post-btn btn-secondary" data-msg-id="${msg.id}" style="padding:2px 8px;font-size:var(--fs-xs)" title="Pin this post">📌</button>
          </div>` : ''}
        </div>
        <div style="font-size:var(--fs-base);color:var(--text-primary);word-break:break-word;white-space:pre-wrap">${(() => { const t = tryDecodePost(msg.ciphertext); return t ? escapeHtml(t.length > 1000 ? t.slice(0, 1000) + '…' : t) : '<span style="color:var(--text-tertiary)">[Encrypted post]</span>'; })()}</div>
      </div>
    `).join('')));

    // Mark posts as read
    for (const msg of res.data.messages) {
      api.req(`/channels/${channelId}/read/${msg.id}`, { method: 'POST' }).catch(() => {});
    }

    // Pin buttons
    postsEl.querySelectorAll('.pin-post-btn').forEach(btn => {
      btn.addEventListener('click', async (e) => {
        e.stopPropagation();
        const msgId = (btn as HTMLElement).dataset.msgId!;
        await api.req(`/channels/${channelId}/pin/${msgId}`, { method: 'POST' });
        const container = postsEl.closest('.channels-view')!.parentElement!;
        openChannelDetail(channelId, container);
      });
    });
  } catch {
    postsEl.replaceChildren(parseHTML(`<div style="color:var(--danger);text-align:center;padding:var(--sp-4)">Failed to load posts</div>`));
  }
}

function showPostDialog(channelId: string, isScheduled: boolean, container: HTMLElement) {
  const overlay = document.createElement('div');
  overlay.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,0.5);display:flex;align-items:center;justify-content:center;z-index:9999';
  overlay.replaceChildren(parseHTML(`
    <div style="background:var(--bg-elevated);border-radius:var(--radius-xl);padding:var(--sp-6);width:440px;max-width:90vw;box-shadow:var(--shadow-xl)">
      <h3 style="margin:0 0 var(--sp-4)">${isScheduled ? '🕐 Schedule Post' : '📝 New Post'}</h3>
      <textarea id="post-content" rows="5" placeholder="Write your broadcast message..."
        style="width:100%;padding:12px;border-radius:var(--radius-md);border:1px solid var(--border-norm);background:var(--bg-input);color:var(--text-primary);resize:vertical;font-family:inherit;font-size:var(--fs-base)"></textarea>
      ${isScheduled ? `
        <label style="display:block;margin-top:var(--sp-3);font-size:var(--fs-sm);color:var(--text-secondary)">
          Schedule for:
          <input id="post-schedule-time" type="datetime-local" style="display:block;margin-top:4px;width:100%;padding:8px;border-radius:var(--radius-md);border:1px solid var(--border-norm);background:var(--bg-input);color:var(--text-primary)">
        </label>
      ` : ''}
      <div style="display:flex;gap:var(--sp-2);justify-content:flex-end;margin-top:var(--sp-4)">
        <button id="post-cancel" class="btn-secondary" style="padding:8px 16px">Cancel</button>
        <button id="post-send" class="btn-primary" style="padding:8px 16px">${isScheduled ? 'Schedule' : 'Post'}</button>
      </div>
    </div>
  `));
  document.body.appendChild(overlay);
  overlay.addEventListener('click', (e) => { if (e.target === overlay) overlay.remove(); });
  overlay.querySelector('#post-cancel')?.addEventListener('click', () => overlay.remove());

  overlay.querySelector('#post-send')?.addEventListener('click', async () => {
    const content = (overlay.querySelector('#post-content') as HTMLTextAreaElement).value.trim();
    if (!content) return;

    // Channel posts are base64-encoded plaintext today; server-side sender-key
    // encryption is tracked as a separate spec item and applied to all clients.
    const ciphertext = toBase64(new TextEncoder().encode(content));

    if (isScheduled) {
      const timeInput = overlay.querySelector('#post-schedule-time') as HTMLInputElement;
      if (!timeInput.value) return;
      const scheduledAt = Math.floor(new Date(timeInput.value).getTime() / 1000);
      const r = await api.req(`/channels/${channelId}/schedule`, {
        method: 'POST',
        body: JSON.stringify({ ciphertext, iv: '', scheduled_at: scheduledAt }),
      });
      if (r.ok) {
        overlay.remove();
        openChannelDetail(channelId, container);
      }
    } else {
      const r = await api.req(`/channels/${channelId}/post`, {
        method: 'POST',
        body: JSON.stringify({ ciphertext, iv: '', ratchet_header: '{}', message_type: 'text' }),
      });
      if (r.ok) {
        overlay.remove();
        openChannelDetail(channelId, container);
      }
    }
  });
}

function showScheduledPosts(channelId: string) {
  const overlay = document.createElement('div');
  overlay.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,0.5);display:flex;align-items:center;justify-content:center;z-index:9999';
  overlay.replaceChildren(parseHTML(`
    <div style="background:var(--bg-elevated);border-radius:var(--radius-xl);padding:var(--sp-6);width:480px;max-width:90vw;max-height:70vh;overflow-y:auto;box-shadow:var(--shadow-xl)">
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:var(--sp-4)">
        <h3 style="margin:0">📋 Scheduled Posts</h3>
        <button id="sched-close" class="btn-secondary" style="padding:4px 12px">✕</button>
      </div>
      <div id="sched-list" style="display:flex;flex-direction:column;gap:var(--sp-3)">
        <div style="text-align:center;color:var(--text-secondary)">Loading...</div>
      </div>
    </div>
  `));
  document.body.appendChild(overlay);
  overlay.addEventListener('click', (e) => { if (e.target === overlay) overlay.remove(); });
  overlay.querySelector('#sched-close')?.addEventListener('click', () => overlay.remove());

  api.req<{ posts: Array<{ id: string; ciphertext: string; scheduled_at: number; created_at: number }> }>(`/channels/${channelId}/scheduled`, { method: 'GET' }).then(r => {
    const list = overlay.querySelector('#sched-list')!;
    if (!r.data?.posts?.length) {
      list.replaceChildren(parseHTML(`<div style="text-align:center;color:var(--text-secondary)">No scheduled posts</div>`));
      return;
    }
    list.replaceChildren(parseHTML(r.data.posts.map(p => `
      <div style="padding:var(--sp-3);border:1px solid var(--border-weak);border-radius:var(--radius-md);background:var(--bg-card)">
        <div style="display:flex;justify-content:space-between;align-items:center">
          <span style="font-size:var(--fs-sm);color:var(--text-secondary)">⏰ ${new Date(p.scheduled_at * 1000).toLocaleString()}</span>
          <button class="cancel-sched btn-secondary" data-id="${p.id}" style="padding:2px 8px;font-size:var(--fs-xs);color:var(--danger)">Cancel</button>
        </div>
        <div style="margin-top:4px;font-size:var(--fs-sm);color:var(--text-primary);white-space:pre-wrap">${(() => { const t = tryDecodePost(p.ciphertext); return t ? escapeHtml(t.length > 280 ? t.slice(0, 280) + '…' : t) : '<span style="color:var(--text-tertiary)">[Encrypted]</span>'; })()}</div>
      </div>
    `).join('')));

    list.querySelectorAll('.cancel-sched').forEach(btn => {
      btn.addEventListener('click', async () => {
        const postId = (btn as HTMLElement).dataset.id!;
        await api.req(`/channels/${channelId}/scheduled/${postId}`, { method: 'DELETE' });
        (btn as HTMLElement).closest('div[style*="padding"]')!.remove();
      });
    });
  });
}

function showAnalytics(channelId: string) {
  const overlay = document.createElement('div');
  overlay.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,0.5);display:flex;align-items:center;justify-content:center;z-index:9999';
  overlay.replaceChildren(parseHTML(`
    <div style="background:var(--bg-elevated);border-radius:var(--radius-xl);padding:var(--sp-6);width:520px;max-width:90vw;max-height:70vh;overflow-y:auto;box-shadow:var(--shadow-xl)">
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:var(--sp-4)">
        <h3 style="margin:0">📊 Channel Analytics</h3>
        <button id="analytics-close" class="btn-secondary" style="padding:4px 12px">✕</button>
      </div>
      <div id="analytics-content">
        <div style="text-align:center;color:var(--text-secondary)">Loading...</div>
      </div>
    </div>
  `));
  document.body.appendChild(overlay);
  overlay.addEventListener('click', (e) => { if (e.target === overlay) overlay.remove(); });
  overlay.querySelector('#analytics-close')?.addEventListener('click', () => overlay.remove());

  api.req<{ subscriber_count: number; posts: Array<{ id: string; created_at: number; read_count: number }> }>(`/channels/${channelId}/analytics`, { method: 'GET' }).then(r => {
    const content = overlay.querySelector('#analytics-content')!;
    if (!r.ok || !r.data) {
      content.replaceChildren(parseHTML(`<div style="color:var(--danger)">Failed to load analytics</div>`));
      return;
    }

    const totalReads = r.data.posts.reduce((sum, p) => sum + (p.read_count || 0), 0);
    const avgReads = r.data.posts.length ? Math.round(totalReads / r.data.posts.length) : 0;

    content.replaceChildren(parseHTML(`
      <div style="display:grid;grid-template-columns:repeat(3,1fr);gap:var(--sp-3);margin-bottom:var(--sp-4)">
        <div style="text-align:center;padding:var(--sp-4);background:var(--bg-card);border-radius:var(--radius-md);border:1px solid var(--border-weak)">
          <div style="font-size:var(--fs-2xl);font-weight:700;color:var(--roc-gold)">${r.data.subscriber_count}</div>
          <div style="font-size:var(--fs-xs);color:var(--text-secondary)">Subscribers</div>
        </div>
        <div style="text-align:center;padding:var(--sp-4);background:var(--bg-card);border-radius:var(--radius-md);border:1px solid var(--border-weak)">
          <div style="font-size:var(--fs-2xl);font-weight:700;color:var(--roc-gold)">${r.data.posts.length}</div>
          <div style="font-size:var(--fs-xs);color:var(--text-secondary)">Total Posts</div>
        </div>
        <div style="text-align:center;padding:var(--sp-4);background:var(--bg-card);border-radius:var(--radius-md);border:1px solid var(--border-weak)">
          <div style="font-size:var(--fs-2xl);font-weight:700;color:var(--roc-gold)">${avgReads}</div>
          <div style="font-size:var(--fs-xs);color:var(--text-secondary)">Avg Reads/Post</div>
        </div>
      </div>

      <h4 style="margin:0 0 var(--sp-3);font-size:var(--fs-base)">Post Performance</h4>
      <div style="display:flex;flex-direction:column;gap:var(--sp-2)">
        ${r.data.posts.map(p => {
          const pct = r.data!.subscriber_count > 0 ? Math.round((p.read_count / r.data!.subscriber_count) * 100) : 0;
          return `
            <div style="display:flex;align-items:center;gap:var(--sp-3);padding:var(--sp-2) var(--sp-3);border:1px solid var(--border-weak);border-radius:var(--radius-sm);background:var(--bg-card)">
              <span style="font-size:var(--fs-xs);color:var(--text-tertiary);min-width:120px">${new Date(p.created_at * 1000).toLocaleDateString()}</span>
              <div style="flex:1;height:8px;background:var(--bg-input);border-radius:4px;overflow:hidden">
                <div style="height:100%;width:${Math.min(pct, 100)}%;background:var(--roc-gold);border-radius:4px;transition:width 0.3s"></div>
              </div>
              <span style="font-size:var(--fs-xs);color:var(--text-secondary);min-width:80px;text-align:right">${p.read_count} reads (${pct}%)</span>
            </div>
          `;
        }).join('')}
      </div>
    `));
  });
}

async function loadCommunities(query = '') {
  const list = document.getElementById('communities-list');
  if (!list) return;

  try {
    const params = new URLSearchParams();
    if (query) params.set('q', query);
    const res = await api.req<{ communities: Community[] }>(`/communities/discover?${params}`, { method: 'GET' });
    if (!res.ok || !res.data?.communities?.length) {
      list.replaceChildren(parseHTML(`<div style="text-align:center;padding:var(--sp-4);color:var(--text-secondary)">No communities yet</div>`));
      return;
    }

    list.replaceChildren(parseHTML(res.data.communities.map((c: Community) => `
      <div class="community-card" data-id="${c.id}" style="border-radius:var(--radius-lg);border:1px solid var(--border-weak);background:var(--bg-card);overflow:hidden;transition:background var(--duration-fast) var(--ease-out)">
        <div class="community-header" style="padding:var(--sp-4);cursor:pointer;display:flex;align-items:center;gap:var(--sp-3)">
          <div style="width:40px;height:40px;border-radius:var(--radius-md);background:rgba(64,224,208,0.1);display:flex;align-items:center;justify-content:center;font-size:18px">🏘️</div>
          <div style="flex:1">
            <div style="font-weight:600">${c.name}</div>
            <div style="font-size:var(--fs-sm);color:var(--text-secondary)">${c.description || 'No description'}</div>
          </div>
          <div style="display:flex;align-items:center;gap:var(--sp-2)">
            <span style="font-size:var(--fs-xs);color:var(--text-tertiary)">${c.member_count} members</span>
            <span class="community-chevron" style="font-size:12px;color:var(--text-tertiary);transition:transform 0.2s">▶</span>
          </div>
        </div>
        <div class="community-channels" data-community-id="${c.id}" style="display:none;padding:0 var(--sp-4) var(--sp-3);border-top:1px solid var(--border-weak)"></div>
      </div>
    `).join('')));

    list.querySelectorAll('.community-header').forEach(header => {
      header.addEventListener('click', async () => {
        const card = header.closest('.community-card') as HTMLElement;
        const id = card.dataset.id!;
        const channelsEl = card.querySelector('.community-channels') as HTMLElement;
        const chevron = card.querySelector('.community-chevron') as HTMLElement;

        if (channelsEl.style.display === 'none') {
          channelsEl.style.display = 'block';
          chevron.style.transform = 'rotate(90deg)';

          if (!channelsEl.dataset.loaded) {
            channelsEl.replaceChildren(parseHTML('<div style="padding:var(--sp-2);color:var(--text-secondary);font-size:var(--fs-sm)">Loading channels...</div>'));
            try {
              const detail = await api.req<{ community: any; channels: Channel[]; role: string | null }>(`/communities/${id}`, { method: 'GET' });
              if (detail.ok && detail.data?.channels?.length) {
                channelsEl.replaceChildren(parseHTML(detail.data.channels.map((ch: Channel) => `
                  <div class="community-channel-row" data-channel-id="${ch.id}" style="padding:var(--sp-2) var(--sp-3);margin-top:var(--sp-2);border-radius:var(--radius-md);background:var(--bg-input);cursor:pointer;display:flex;align-items:center;gap:var(--sp-2);transition:background var(--duration-fast)">
                    <span style="font-size:16px">#</span>
                    <div style="flex:1">
                      <div style="font-size:var(--fs-sm);font-weight:500">${ch.name}</div>
                      ${ch.description ? `<div style="font-size:var(--fs-xs);color:var(--text-secondary)">${ch.description}</div>` : ''}
                    </div>
                    <span style="font-size:var(--fs-xs);color:var(--text-tertiary)">${ch.subscriber_count || 0} subs</span>
                  </div>
                `).join('')));

                channelsEl.querySelectorAll('.community-channel-row').forEach(row => {
                  row.addEventListener('click', (e) => {
                    e.stopPropagation();
                    const chId = (row as HTMLElement).dataset.channelId!;
                    const ch = detail.data!.channels.find((c: Channel) => c.id === chId);
                    if (ch) {
                      activeChannel = ch;
                      currentView = 'detail';
                      const container = document.querySelector('.channels-view')?.parentElement;
                      if (container) renderChannelDetail(container as HTMLElement);
                    }
                  });
                });

                const myRole = detail.data?.community?.my_role;

                // Admin controls: add channel to community
                if (myRole === 'owner' || myRole === 'admin') {
                  const adminBar = document.createElement('div');
                  adminBar.style.cssText = 'display:flex;gap:var(--sp-2);margin-top:var(--sp-2)';
                  const addChBtn = document.createElement('button');
                  addChBtn.className = 'btn-secondary';
                  addChBtn.style.cssText = 'flex:1;padding:6px 14px;font-size:var(--fs-sm)';
                  addChBtn.textContent = '+ Add Channel';
                  addChBtn.addEventListener('click', (e) => {
                    e.stopPropagation();
                    showCreateChannelForCommunity(id, channelsEl, list!.closest('.channels-view')?.parentElement as HTMLElement);
                  });
                  const editBtn = document.createElement('button');
                  editBtn.className = 'btn-secondary';
                  editBtn.style.cssText = 'padding:6px 14px;font-size:var(--fs-sm)';
                  editBtn.textContent = '⚙ Settings';
                  editBtn.addEventListener('click', (e) => {
                    e.stopPropagation();
                    showCommunitySettings(id, detail.data!.community, list!.closest('.channels-view')?.parentElement as HTMLElement);
                  });
                  adminBar.appendChild(addChBtn);
                  adminBar.appendChild(editBtn);
                  channelsEl.appendChild(adminBar);
                }

                // Add join button if not a member
                if (!myRole) {
                  const joinBtn = document.createElement('button');
                  joinBtn.className = 'btn-primary';
                  joinBtn.style.cssText = 'margin-top:var(--sp-2);padding:6px 14px;font-size:var(--fs-sm);width:100%';
                  joinBtn.textContent = 'Join Community';
                  joinBtn.addEventListener('click', async (e) => {
                    e.stopPropagation();
                    const r = await api.req(`/communities/${id}/join`, { method: 'POST' });
                    if (r.ok) { joinBtn.textContent = '✓ Joined'; joinBtn.disabled = true; }
                  });
                  channelsEl.appendChild(joinBtn);
                } else if (myRole === 'member') {
                  const leaveBtn = document.createElement('button');
                  leaveBtn.className = 'btn-secondary';
                  leaveBtn.style.cssText = 'margin-top:var(--sp-2);padding:6px 14px;font-size:var(--fs-sm);width:100%;color:var(--danger)';
                  leaveBtn.textContent = 'Leave Community';
                  leaveBtn.addEventListener('click', async (e) => {
                    e.stopPropagation();
                    if (!confirm('Leave this community?')) return;
                    const r = await api.req(`/communities/${id}/leave`, { method: 'DELETE' });
                    if (r.ok) { leaveBtn.textContent = '✓ Left'; leaveBtn.disabled = true; }
                  });
                  channelsEl.appendChild(leaveBtn);
                }
              } else {
                channelsEl.replaceChildren(parseHTML('<div style="padding:var(--sp-2);color:var(--text-secondary);font-size:var(--fs-sm)">No channels in this community</div>'));
              }
            } catch {
              channelsEl.replaceChildren(parseHTML('<div style="padding:var(--sp-2);color:var(--danger);font-size:var(--fs-sm)">Failed to load</div>'));
            }
            channelsEl.dataset.loaded = '1';
          }
        } else {
          channelsEl.style.display = 'none';
          chevron.style.transform = '';
        }
      });
    });
  } catch {
    list.replaceChildren(parseHTML(`<div style="color:var(--danger);text-align:center;padding:var(--sp-4)">Failed to load communities</div>`));
  }
}

function showCreateChannelDialog(container: HTMLElement) {
  const existing = document.querySelector('.create-channel-overlay');
  if (existing) existing.remove();

  const overlay = document.createElement('div');
  overlay.className = 'create-channel-overlay';
  overlay.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,0.5);display:flex;align-items:center;justify-content:center;z-index:9999';
  overlay.replaceChildren(parseHTML(`
    <div style="background:var(--bg-elevated);border-radius:var(--radius-xl);padding:var(--sp-6);width:400px;max-width:90vw;box-shadow:var(--shadow-xl)">
      <h3 style="margin:0 0 var(--sp-4)">Create Channel</h3>
      <div style="display:flex;flex-direction:column;gap:var(--sp-3)">
        <input id="new-ch-name" type="text" placeholder="Channel name" maxlength="64"
          style="padding:10px 14px;border-radius:var(--radius-md);border:1px solid var(--border-norm);background:var(--bg-input);color:var(--text-primary)" />
        <input id="new-ch-desc" type="text" placeholder="Description (optional)" maxlength="200"
          style="padding:10px 14px;border-radius:var(--radius-md);border:1px solid var(--border-norm);background:var(--bg-input);color:var(--text-primary)" />
        <input id="new-ch-tags" type="text" placeholder="Tags (comma separated)"
          style="padding:10px 14px;border-radius:var(--radius-md);border:1px solid var(--border-norm);background:var(--bg-input);color:var(--text-primary)" />
        <label style="display:flex;align-items:center;gap:var(--sp-2);font-size:var(--fs-sm);color:var(--text-secondary)">
          <input id="new-ch-public" type="checkbox" checked /> Public (discoverable)
        </label>
        <div style="display:flex;gap:var(--sp-2);justify-content:flex-end;margin-top:var(--sp-2)">
          <button id="new-ch-cancel" class="btn-secondary" style="padding:8px 16px">Cancel</button>
          <button id="new-ch-create" class="btn-primary" style="padding:8px 16px">Create</button>
        </div>
      </div>
    </div>
  `));

  document.body.appendChild(overlay);

  overlay.addEventListener('click', (e) => {
    if (e.target === overlay) overlay.remove();
  });

  document.getElementById('new-ch-cancel')?.addEventListener('click', () => overlay.remove());

  document.getElementById('new-ch-create')?.addEventListener('click', async () => {
    const name = (document.getElementById('new-ch-name') as HTMLInputElement).value.trim();
    const description = (document.getElementById('new-ch-desc') as HTMLInputElement).value.trim();
    const tags = (document.getElementById('new-ch-tags') as HTMLInputElement).value.trim();
    const is_public = (document.getElementById('new-ch-public') as HTMLInputElement).checked;

    if (!name || name.length < 2) {
      alert('Channel name must be at least 2 characters');
      return;
    }

    const res = await api.req('/channels', {
      method: 'POST',
      body: JSON.stringify({ name, description, tags, is_public }),
    });

    if (res.ok) {
      overlay.remove();
      renderDiscoverView(container);
    } else {
      alert('Failed to create channel');
    }
  });
}

function showCreateCommunityDialog(container: HTMLElement) {
  const existing = document.querySelector('.create-community-overlay');
  if (existing) existing.remove();

  const overlay = document.createElement('div');
  overlay.className = 'create-community-overlay';
  overlay.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,0.5);display:flex;align-items:center;justify-content:center;z-index:9999';
  overlay.replaceChildren(parseHTML(`
    <div style="background:var(--bg-elevated);border-radius:var(--radius-xl);padding:var(--sp-6);width:440px;max-width:90vw;box-shadow:var(--shadow-xl)">
      <h3 style="margin:0 0 var(--sp-4)">Create Community</h3>
      <p style="font-size:var(--fs-sm);color:var(--text-secondary);margin:0 0 var(--sp-4)">Communities group multiple channels under one namespace.</p>
      <div style="display:flex;flex-direction:column;gap:var(--sp-3)">
        <input id="new-comm-name" type="text" placeholder="Community name" maxlength="64"
          style="padding:10px 14px;border-radius:var(--radius-md);border:1px solid var(--border-norm);background:var(--bg-input);color:var(--text-primary)" />
        <input id="new-comm-desc" type="text" placeholder="Description (optional)" maxlength="200"
          style="padding:10px 14px;border-radius:var(--radius-md);border:1px solid var(--border-norm);background:var(--bg-input);color:var(--text-primary)" />
        <label style="display:flex;align-items:center;gap:var(--sp-2);font-size:var(--fs-sm);color:var(--text-secondary)">
          <input id="new-comm-public" type="checkbox" checked /> Public (discoverable)
        </label>
        <div style="display:flex;gap:var(--sp-2);justify-content:flex-end;margin-top:var(--sp-2)">
          <button id="new-comm-cancel" class="btn-secondary" style="padding:8px 16px">Cancel</button>
          <button id="new-comm-create" class="btn-primary" style="padding:8px 16px">Create</button>
        </div>
      </div>
    </div>
  `));

  document.body.appendChild(overlay);
  overlay.addEventListener('click', (e) => { if (e.target === overlay) overlay.remove(); });
  document.getElementById('new-comm-cancel')?.addEventListener('click', () => overlay.remove());

  document.getElementById('new-comm-create')?.addEventListener('click', async () => {
    const name = (document.getElementById('new-comm-name') as HTMLInputElement).value.trim();
    const description = (document.getElementById('new-comm-desc') as HTMLInputElement).value.trim();
    const is_public = (document.getElementById('new-comm-public') as HTMLInputElement).checked;

    if (!name || name.length < 2) {
      alert('Community name must be at least 2 characters');
      return;
    }

    const res = await api.req('/communities', {
      method: 'POST',
      body: JSON.stringify({ name, description, is_public }),
    });

    if (res.ok) {
      overlay.remove();
      renderDiscoverView(container);
    } else {
      alert('Failed to create community');
    }
  });
}

function showCreateChannelForCommunity(communityId: string, channelsEl: HTMLElement, container: HTMLElement) {
  const existing = document.querySelector('.create-channel-overlay');
  if (existing) existing.remove();

  const overlay = document.createElement('div');
  overlay.className = 'create-channel-overlay';
  overlay.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,0.5);display:flex;align-items:center;justify-content:center;z-index:9999';
  overlay.replaceChildren(parseHTML(`
    <div style="background:var(--bg-elevated);border-radius:var(--radius-xl);padding:var(--sp-6);width:400px;max-width:90vw;box-shadow:var(--shadow-xl)">
      <h3 style="margin:0 0 var(--sp-4)">Add Channel to Community</h3>
      <div style="display:flex;flex-direction:column;gap:var(--sp-3)">
        <input id="comm-ch-name" type="text" placeholder="Channel name" maxlength="64"
          style="padding:10px 14px;border-radius:var(--radius-md);border:1px solid var(--border-norm);background:var(--bg-input);color:var(--text-primary)" />
        <input id="comm-ch-desc" type="text" placeholder="Description (optional)" maxlength="200"
          style="padding:10px 14px;border-radius:var(--radius-md);border:1px solid var(--border-norm);background:var(--bg-input);color:var(--text-primary)" />
        <div style="display:flex;gap:var(--sp-2);justify-content:flex-end;margin-top:var(--sp-2)">
          <button id="comm-ch-cancel" class="btn-secondary" style="padding:8px 16px">Cancel</button>
          <button id="comm-ch-create" class="btn-primary" style="padding:8px 16px">Create</button>
        </div>
      </div>
    </div>
  `));

  document.body.appendChild(overlay);
  overlay.addEventListener('click', (e) => { if (e.target === overlay) overlay.remove(); });
  document.getElementById('comm-ch-cancel')?.addEventListener('click', () => overlay.remove());

  document.getElementById('comm-ch-create')?.addEventListener('click', async () => {
    const name = (document.getElementById('comm-ch-name') as HTMLInputElement).value.trim();
    const description = (document.getElementById('comm-ch-desc') as HTMLInputElement).value.trim();

    if (!name || name.length < 2) {
      alert('Channel name must be at least 2 characters');
      return;
    }

    const res = await api.req('/channels', {
      method: 'POST',
      body: JSON.stringify({ name, description, community_id: communityId, is_public: true }),
    });

    if (res.ok) {
      overlay.remove();
      channelsEl.dataset.loaded = '';
      channelsEl.style.display = 'none';
      // Re-expand to reload
      (channelsEl.previousElementSibling as HTMLElement)?.click();
    } else {
      alert('Failed to create channel');
    }
  });
}

function showCommunitySettings(communityId: string, community: any, container: HTMLElement) {
  const existing = document.querySelector('.community-settings-overlay');
  if (existing) existing.remove();

  const overlay = document.createElement('div');
  overlay.className = 'community-settings-overlay';
  overlay.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,0.5);display:flex;align-items:center;justify-content:center;z-index:9999';
  overlay.replaceChildren(parseHTML(`
    <div style="background:var(--bg-elevated);border-radius:var(--radius-xl);padding:var(--sp-6);width:440px;max-width:90vw;box-shadow:var(--shadow-xl)">
      <h3 style="margin:0 0 var(--sp-4)">Community Settings</h3>
      <div style="display:flex;flex-direction:column;gap:var(--sp-3)">
        <div>
          <label style="font-size:var(--fs-sm);color:var(--text-secondary);margin-bottom:4px;display:block">Name</label>
          <input id="comm-edit-name" type="text" value="${community.name || ''}" maxlength="64"
            style="padding:10px 14px;border-radius:var(--radius-md);border:1px solid var(--border-norm);background:var(--bg-input);color:var(--text-primary);width:100%" />
        </div>
        <div>
          <label style="font-size:var(--fs-sm);color:var(--text-secondary);margin-bottom:4px;display:block">Description</label>
          <input id="comm-edit-desc" type="text" value="${community.description || ''}" maxlength="200"
            style="padding:10px 14px;border-radius:var(--radius-md);border:1px solid var(--border-norm);background:var(--bg-input);color:var(--text-primary);width:100%" />
        </div>
        <div style="padding:var(--sp-3);background:var(--bg-secondary);border-radius:var(--radius-md)">
          <div style="font-size:var(--fs-sm);color:var(--text-secondary)">Members: <strong style="color:var(--text-primary)">${community.member_count || 0}</strong></div>
          <div style="font-size:var(--fs-sm);color:var(--text-secondary);margin-top:4px">Created: <strong style="color:var(--text-primary)">${community.created_at ? new Date(community.created_at * 1000).toLocaleDateString() : 'Unknown'}</strong></div>
        </div>
        <div style="display:flex;gap:var(--sp-2);justify-content:flex-end;margin-top:var(--sp-2)">
          <button id="comm-edit-cancel" class="btn-secondary" style="padding:8px 16px">Cancel</button>
          <button id="comm-edit-save" class="btn-primary" style="padding:8px 16px">Save Changes</button>
        </div>
      </div>
    </div>
  `));

  document.body.appendChild(overlay);
  overlay.addEventListener('click', (e) => { if (e.target === overlay) overlay.remove(); });
  document.getElementById('comm-edit-cancel')?.addEventListener('click', () => overlay.remove());

  document.getElementById('comm-edit-save')?.addEventListener('click', async () => {
    const name = (document.getElementById('comm-edit-name') as HTMLInputElement).value.trim();
    const description = (document.getElementById('comm-edit-desc') as HTMLInputElement).value.trim();

    if (!name || name.length < 2) {
      alert('Community name must be at least 2 characters');
      return;
    }

    const res = await api.req(`/communities/${communityId}`, {
      method: 'PATCH',
      body: JSON.stringify({ name, description }),
    });

    if (res.ok) {
      overlay.remove();
      renderDiscoverView(container);
    } else {
      alert('Failed to update community');
    }
  });
}
