/**
 * RocChat — Emoji & Sticker Picker (Self-Hosted)
 *
 * Zero third-party dependencies. No Google, no Tenor, no surveillance.
 * Uses built-in Unicode emoji, CSS-animated expressions, and self-hosted sticker packs.
 *
 * Part of the Roc Family ecosystem — the voice of freedom.
 */

import * as api from '../api.js';
import { parseHTML } from '../utils.js';

const EMOJI_CATEGORIES: Record<string, string[]> = {
  'Smileys': ['😀','😂','🤣','😊','😍','🥰','😘','😜','🤪','😎','🥳','😇','🤩','🥺','😭','😤','🤯','🫡','🫶','❤️','🔥','✨','💯','👏','🙌','👊','✊','🤝','💪','🕊️'],
  'Roc Spirit': ['🪶','🦅','🏔️','⛰️','🌄','🌅','🌍','🕊️','✊','🔒','🛡️','💛','🖤','🤎','❤️‍🔥','🏴','🪧','📢','🎯','⚡','🌊','🌿','🌱','🫂','🤲','🙏','💎','👑','🦁','🇵🇸'],
  'Gestures': ['👍','👎','👋','🤙','✌️','🤞','🫰','🤟','🤘','👆','👇','👉','👈','🫵','🖐️','✋','🤚','👐','🤲','🙏','💅','🫶','🤝','👊','✊','🤛','🤜','🫳','🫴','💪'],
  'Objects': ['🔒','🔑','🗝️','🛡️','⚔️','🏴','📱','💻','🖥️','⌨️','🎵','🎶','📷','🎬','📖','✏️','📌','🔗','💰','🪙','🎁','🏆','🎖️','🧭','⏰','💡','🔋','📡','🌐','🗺️'],
  'Nature': ['🌍','🌎','🌏','🌙','⭐','🌟','☀️','🌤️','⛅','🌧️','⛈️','🌊','🏔️','🌋','🏜️','🌲','🌳','🌿','🍀','🌸','🌺','🌻','🌹','🦅','🦁','🐻','🐺','🦋','🐝','🕊️'],
  'Flags': ['🏴','🏳️','🏁','🚩','🏳️‍🌈','🏴‍☠️','🇵🇸','🇱🇧','🇾🇪','🇸🇾','🇮🇶','🇱🇾','🇸🇩','🇸🇴','🇪🇬','🇯🇴','🇩🇿','🇹🇳','🇲🇦','🇲🇷','🇹🇷','🇮🇷','🇲🇾','🇮🇩','🇧🇩','🇵🇰','🇿🇦','🇧🇷','🇨🇺','🇻🇪'],
};

const ANIMATED_EXPRESSIONS: { name: string; emoji: string; animation: string }[] = [
  { name: 'Celebrate', emoji: '🎉', animation: 'roc-bounce 0.5s ease infinite alternate' },
  { name: 'Fire', emoji: '🔥', animation: 'roc-pulse 0.8s ease infinite' },
  { name: 'Heart', emoji: '❤️', animation: 'roc-heartbeat 1s ease infinite' },
  { name: 'Roc Fly', emoji: '🦅', animation: 'roc-fly 2s ease infinite' },
  { name: 'Peace', emoji: '🕊️', animation: 'roc-fly 3s ease infinite' },
  { name: 'Strength', emoji: '✊', animation: 'roc-shake 0.5s ease infinite' },
  { name: 'Stars', emoji: '✨', animation: 'roc-sparkle 1.5s ease infinite' },
  { name: 'Wave', emoji: '👋', animation: 'roc-wave 1s ease infinite' },
  { name: 'Clap', emoji: '👏', animation: 'roc-bounce 0.6s ease infinite alternate' },
  { name: 'Freedom', emoji: '🏴', animation: 'roc-wave 2s ease infinite' },
  { name: 'Shield', emoji: '🛡️', animation: 'roc-pulse 1.2s ease infinite' },
  { name: 'Palestine', emoji: '🇵🇸', animation: 'roc-wave 1.5s ease infinite' },
];

let debounceTimer: ReturnType<typeof setTimeout>;

export function initGifPicker(
  container: HTMLElement,
  toggleBtn: HTMLElement,
  onSelect: (gifUrl: string, previewUrl: string, width: number, height: number) => void,
) {
  let visible = false;
  let activeTab: 'emoji' | 'stickers' | 'animated' = 'emoji';
  let activeCat = Object.keys(EMOJI_CATEGORIES)[0];

  function ensureAnimStyles() {
    if (document.getElementById('roc-anim-styles')) return;
    const style = document.createElement('style');
    style.id = 'roc-anim-styles';
    style.textContent = `
      @keyframes roc-bounce{from{transform:translateY(0)}to{transform:translateY(-8px)}}
      @keyframes roc-pulse{0%,100%{transform:scale(1)}50%{transform:scale(1.3)}}
      @keyframes roc-heartbeat{0%,100%{transform:scale(1)}14%{transform:scale(1.3)}28%{transform:scale(1)}42%{transform:scale(1.3)}}
      @keyframes roc-fly{0%{transform:translate(0,0)}50%{transform:translate(6px,-6px)}100%{transform:translate(0,0)}}
      @keyframes roc-shake{0%,100%{transform:rotate(0)}25%{transform:rotate(-15deg)}75%{transform:rotate(15deg)}}
      @keyframes roc-sparkle{0%,100%{opacity:1;transform:scale(1)}50%{opacity:0.5;transform:scale(1.2)}}
      @keyframes roc-wave{0%{transform:rotate(0)}25%{transform:rotate(20deg)}50%{transform:rotate(0)}75%{transform:rotate(-10deg)}}
    `;
    document.head.appendChild(style);
  }

  function bindEmojiClicks(grid: HTMLElement) {
    grid.querySelectorAll('.emoji-item').forEach(btn => {
      btn.addEventListener('click', () => {
        const emoji = (btn as HTMLElement).dataset.emoji || '';
        onSelect(`emoji:${emoji}`, emoji, 120, 120);
        hide();
      });
    });
  }

  function renderEmoji() {
    const grid = container.querySelector('.gif-picker-grid') as HTMLElement;
    if (!grid) return;
    const emojis = EMOJI_CATEGORIES[activeCat] || [];
    grid.replaceChildren(parseHTML(emojis.map(e =>
      `<button class="gif-item emoji-item" data-emoji="${e}" title="${e}" style="font-size:28px;background:none;border:none;cursor:pointer;padding:6px;border-radius:8px;transition:transform 0.1s">${e}</button>`
    ).join('')));
    bindEmojiClicks(grid);
  }

  function renderAnimated() {
    const grid = container.querySelector('.gif-picker-grid') as HTMLElement;
    if (!grid) return;
    ensureAnimStyles();

    grid.replaceChildren(parseHTML(ANIMATED_EXPRESSIONS.map(e =>
      `<button class="gif-item animated-item" data-name="${escapeAttr(e.name)}" data-emoji="${e.emoji}" title="${escapeAttr(e.name)}" style="font-size:36px;background:none;border:none;cursor:pointer;padding:8px;border-radius:8px;display:flex;flex-direction:column;align-items:center;gap:2px">
        <span style="animation:${e.animation};display:inline-block">${e.emoji}</span>
        <span style="font-size:9px;color:var(--text-tertiary)">${escapeAttr(e.name)}</span>
      </button>`
    ).join('')));

    grid.querySelectorAll('.animated-item').forEach(btn => {
      btn.addEventListener('click', () => {
        const el = btn as HTMLElement;
        onSelect(`animated:${el.dataset.emoji}:${el.dataset.name}`, el.dataset.emoji || '', 120, 120);
        hide();
      });
    });
  }

  async function renderStickers() {
    const grid = container.querySelector('.gif-picker-grid') as HTMLElement;
    if (!grid) return;
    grid.replaceChildren(parseHTML('<div style="padding:16px;text-align:center;color:var(--text-tertiary);font-size:13px">Loading stickers…</div>'));

    try {
      const res = await api.getStickers();
      if (!res.ok || !res.data.stickers?.length) {
        grid.replaceChildren(parseHTML('<div style="padding:16px;text-align:center;color:var(--text-tertiary);font-size:13px">No sticker packs yet.<br>Community stickers coming soon! 🪶</div>'));
        return;
      }
      grid.replaceChildren(parseHTML(res.data.stickers.map((s: { url: string; name: string; width: number; height: number }) =>
        `<button class="gif-item sticker-item" data-url="${escapeAttr(s.url)}" data-name="${escapeAttr(s.name)}" data-w="${s.width}" data-h="${s.height}" title="${escapeAttr(s.name)}">
          <img src="${escapeAttr(s.url)}" alt="${escapeAttr(s.name)}" loading="lazy" style="max-width:80px;max-height:80px;object-fit:contain" />
        </button>`
      ).join('')));
      grid.querySelectorAll('.sticker-item').forEach(btn => {
        btn.addEventListener('click', () => {
          const el = btn as HTMLElement;
          onSelect(el.dataset.url || '', el.dataset.url || '', parseInt(el.dataset.w || '120'), parseInt(el.dataset.h || '120'));
          hide();
        });
      });
    } catch {
      grid.replaceChildren(parseHTML('<div style="padding:16px;text-align:center;color:var(--text-tertiary);font-size:13px">Could not load stickers</div>'));
    }
  }

  function render() {
    container.replaceChildren(parseHTML(`
      <div style="display:flex;border-bottom:1px solid var(--border);margin-bottom:4px">
        <button class="gif-tab" data-tab="emoji" style="flex:1;padding:6px;font-size:12px;background:none;border:none;cursor:pointer;color:var(--text-primary);border-bottom:2px solid ${activeTab === 'emoji' ? 'var(--roc-gold)' : 'transparent'}">Emoji</button>
        <button class="gif-tab" data-tab="animated" style="flex:1;padding:6px;font-size:12px;background:none;border:none;cursor:pointer;color:var(--text-primary);border-bottom:2px solid ${activeTab === 'animated' ? 'var(--roc-gold)' : 'transparent'}">Animated</button>
        <button class="gif-tab" data-tab="stickers" style="flex:1;padding:6px;font-size:12px;background:none;border:none;cursor:pointer;color:var(--text-primary);border-bottom:2px solid ${activeTab === 'stickers' ? 'var(--roc-gold)' : 'transparent'}">Stickers</button>
      </div>
      ${activeTab === 'emoji' ? `
        <div style="display:flex;gap:4px;padding:4px 8px;overflow-x:auto;flex-shrink:0">
          ${Object.keys(EMOJI_CATEGORIES).map(cat => `<button class="cat-btn" data-cat="${cat}" style="padding:2px 8px;font-size:10px;border-radius:10px;border:1px solid ${activeCat === cat ? 'var(--roc-gold)' : 'var(--border)'};background:${activeCat === cat ? 'var(--roc-gold)' : 'transparent'};color:${activeCat === cat ? '#000' : 'var(--text-secondary)'};cursor:pointer;white-space:nowrap">${cat}</button>`).join('')}
        </div>
        <div style="padding:4px 8px">
          <input type="text" class="gif-search-input" placeholder="Search emoji…" aria-label="Search emoji" style="width:100%;padding:6px 10px;border-radius:8px;border:1px solid var(--border);background:var(--bg-secondary);color:var(--text-primary);font-size:13px" />
        </div>
      ` : ''}
      <div class="gif-picker-grid" style="display:flex;flex-wrap:wrap;gap:2px;padding:4px;overflow-y:auto;max-height:260px;justify-content:center"></div>
      <div style="padding:4px 8px;text-align:center">
        <span style="font-size:9px;color:var(--text-tertiary)">🪶 Roc Family — No third parties. No tracking.</span>
      </div>
    `));

    container.querySelectorAll('.gif-tab').forEach(tab => {
      tab.addEventListener('click', () => {
        activeTab = (tab as HTMLElement).dataset.tab as typeof activeTab;
        render();
      });
    });

    container.querySelectorAll('.cat-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        activeCat = (btn as HTMLElement).dataset.cat || activeCat;
        render();
      });
    });

    const input = container.querySelector('.gif-search-input') as HTMLInputElement;
    if (input) {
      input.addEventListener('input', () => {
        clearTimeout(debounceTimer);
        debounceTimer = setTimeout(() => {
          const q = input.value.trim().toLowerCase();
          if (!q) { renderEmoji(); return; }
          const allEmoji = Object.values(EMOJI_CATEGORIES).flat();
          const grid = container.querySelector('.gif-picker-grid') as HTMLElement;
          if (!grid) return;
          grid.replaceChildren(parseHTML(allEmoji.map(e =>
            `<button class="gif-item emoji-item" data-emoji="${e}" title="${e}" style="font-size:28px;background:none;border:none;cursor:pointer;padding:6px;border-radius:8px">${e}</button>`
          ).join('')));
          bindEmojiClicks(grid);
        }, 200);
      });
    }

    if (activeTab === 'emoji') renderEmoji();
    else if (activeTab === 'animated') renderAnimated();
    else renderStickers();
  }

  function show() {
    visible = true;
    container.style.display = 'flex';
    container.classList.add('gif-picker-active');
    toggleBtn.setAttribute('aria-expanded', 'true');
    render();
  }

  function hide() {
    visible = false;
    container.style.display = 'none';
    container.classList.remove('gif-picker-active');
    toggleBtn.setAttribute('aria-expanded', 'false');
  }

  toggleBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    if (visible) hide(); else show();
  });

  document.addEventListener('click', (e) => {
    if (visible && !container.contains(e.target as Node) && e.target !== toggleBtn) {
      hide();
    }
  });
}

function escapeAttr(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
}
