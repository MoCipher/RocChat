/**
 * RocChat — Channels & Communities Tab
 * Discover and subscribe to public broadcast channels.
 */
import * as api from '../api.js';

interface Channel {
  id: string;
  name: string;
  description: string;
  subscriber_count: number;
  tags: string;
  avatar_url: string | null;
}

interface Community {
  id: string;
  name: string;
  description: string;
  member_count: number;
  avatar_url: string | null;
}

export function renderChannels(container: HTMLElement) {
  container.innerHTML = `
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

      <h3 style="margin-top:var(--sp-6);font-size:var(--fs-xl);font-weight:600">Communities</h3>
      <div id="communities-list" style="display:flex;flex-direction:column;gap:var(--sp-3);margin-top:var(--sp-3)">
        <div style="text-align:center;padding:var(--sp-4);color:var(--text-secondary)">Loading communities...</div>
      </div>
    </div>
  `;

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
    showCreateChannelDialog();
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
      list.innerHTML = `<div style="text-align:center;padding:var(--sp-6);color:var(--text-secondary)">
        ${query ? 'No channels found for "' + query + '"' : 'No public channels yet. Create one!'}
      </div>`;
      return;
    }

    list.innerHTML = res.data.channels.map((ch: Channel) => `
      <div class="channel-card" data-id="${ch.id}" style="padding:var(--sp-4);border-radius:var(--radius-lg);border:1px solid var(--border-weak);background:var(--bg-card);cursor:pointer;transition:background var(--duration-fast) var(--ease-out)">
        <div style="display:flex;align-items:center;gap:var(--sp-3)">
          <div style="width:40px;height:40px;border-radius:var(--radius-md);background:var(--primary-bg);display:flex;align-items:center;justify-content:center;font-size:18px;color:var(--roc-gold)">📢</div>
          <div style="flex:1;min-width:0">
            <div style="font-weight:600;font-size:var(--fs-base)">${ch.name}</div>
            <div style="font-size:var(--fs-sm);color:var(--text-secondary);overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${ch.description || 'No description'}</div>
          </div>
          <div style="text-align:right">
            <div style="font-size:var(--fs-xs);color:var(--text-tertiary)">${ch.subscriber_count} subscribers</div>
            ${ch.tags ? `<div style="font-size:var(--fs-xs);color:var(--roc-gold);margin-top:2px">${ch.tags.split(',').slice(0, 3).map(t => '#' + t.trim()).join(' ')}</div>` : ''}
          </div>
        </div>
      </div>
    `).join('');

    // Subscribe on click
    list.querySelectorAll('.channel-card').forEach(card => {
      card.addEventListener('click', async () => {
        const id = (card as HTMLElement).dataset.id!;
        const res = await api.req(`/channels/${id}/subscribe`, { method: 'POST' });
        if (res.ok) {
          const nameEl = card.querySelector('div[style*="font-weight:600"]');
          const name = nameEl?.textContent || 'Channel';
          card.innerHTML = `<div style="padding:var(--sp-2);color:var(--success);font-weight:500">✓ Subscribed to ${name}</div>`;
        }
      });
    });
  } catch {
    list.innerHTML = `<div style="color:var(--danger);text-align:center;padding:var(--sp-4)">Failed to load channels</div>`;
  }
}

async function loadCommunities(query = '') {
  const list = document.getElementById('communities-list');
  if (!list) return;

  try {
    const params = new URLSearchParams();
    if (query) params.set('q', query);
    const res = await api.req<{ communities: Community[] }>(`/communities/discover?${params}`, { method: 'GET' });
    if (!res.ok || !res.data?.communities?.length) {
      list.innerHTML = `<div style="text-align:center;padding:var(--sp-4);color:var(--text-secondary)">No communities yet</div>`;
      return;
    }

    list.innerHTML = res.data.communities.map((c: Community) => `
      <div class="community-card" data-id="${c.id}" style="padding:var(--sp-4);border-radius:var(--radius-lg);border:1px solid var(--border-weak);background:var(--bg-card);cursor:pointer;transition:background var(--duration-fast) var(--ease-out)">
        <div style="display:flex;align-items:center;gap:var(--sp-3)">
          <div style="width:40px;height:40px;border-radius:var(--radius-md);background:rgba(64,224,208,0.1);display:flex;align-items:center;justify-content:center;font-size:18px">🏘️</div>
          <div style="flex:1">
            <div style="font-weight:600">${c.name}</div>
            <div style="font-size:var(--fs-sm);color:var(--text-secondary)">${c.description || 'No description'}</div>
          </div>
          <div style="font-size:var(--fs-xs);color:var(--text-tertiary)">${c.member_count} members</div>
        </div>
      </div>
    `).join('');

    list.querySelectorAll('.community-card').forEach(card => {
      card.addEventListener('click', async () => {
        const id = (card as HTMLElement).dataset.id!;
        const res = await api.req(`/communities/${id}/join`, { method: 'POST' });
        if (res.ok) {
          const nameEl = card.querySelector('div[style*="font-weight:600"]');
          const name = nameEl?.textContent || 'Community';
          card.innerHTML = `<div style="padding:var(--sp-2);color:var(--success);font-weight:500">✓ Joined ${name}</div>`;
        }
      });
    });
  } catch {
    list.innerHTML = `<div style="color:var(--danger);text-align:center;padding:var(--sp-4)">Failed to load communities</div>`;
  }
}

function showCreateChannelDialog() {
  const existing = document.querySelector('.create-channel-overlay');
  if (existing) existing.remove();

  const overlay = document.createElement('div');
  overlay.className = 'create-channel-overlay';
  overlay.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,0.5);display:flex;align-items:center;justify-content:center;z-index:9999';
  overlay.innerHTML = `
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
  `;

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
      loadChannels();
    } else {
      alert('Failed to create channel');
    }
  });
}
