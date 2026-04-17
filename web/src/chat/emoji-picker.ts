/**
 * RocChat — Emoji Picker
 *
 * Lightweight emoji picker with categories, search, and recently used.
 */

const CATEGORIES: Record<string, string[]> = {
  'Recently Used': [],
  'Smileys': [
    '😀','😃','😄','😁','😆','😅','🤣','😂','🙂','😊',
    '😇','🥰','😍','🤩','😘','😗','😚','😙','🥲','😋',
    '😛','😜','🤪','😝','🤑','🤗','🤭','🫢','🫣','🤫',
    '🤔','🫡','🤐','🤨','😐','😑','😶','🫠','😏','😒',
    '🙄','😬','🤥','🫨','😌','😔','😪','🤤','😴','😷',
    '🤒','🤕','🤢','🤮','🥵','🥶','🥴','😵','🤯','🤠',
    '🥳','🥸','😎','🤓','🧐','😕','🫤','😟','🙁','😮',
    '😯','😲','😳','🥺','🥹','😦','😧','😨','😰','😥',
    '😢','😭','😱','😖','😣','😞','😓','😩','😫','🥱',
    '😤','😡','😠','🤬','😈','👿','💀','☠️','💩','🤡',
    '👹','👺','👻','👽','👾','🤖','😺','😸','😹','😻',
    '😼','😽','🙀','😿','😾',
  ],
  'Gestures': [
    '👋','🤚','🖐️','✋','🖖','🫱','🫲','🫳','🫴','🫷',
    '🫸','👌','🤌','🤏','✌️','🤞','🫰','🤟','🤘','🤙',
    '👈','👉','👆','🖕','👇','☝️','🫵','👍','👎','✊',
    '👊','🤛','🤜','👏','🙌','🫶','👐','🤲','🤝','🙏',
    '✍️','💅','🤳','💪','🦾','🦿','🦵','🦶','👂','🦻',
    '👃','🧠','🫀','🫁','🦷','🦴','👀','👁️','👅','👄',
  ],
  'People': [
    '👶','🧒','👦','👧','🧑','👱','👨','🧔','👩','🧓',
    '👴','👵','🙍','🙎','🙅','🙆','💁','🙋','🧏','🙇',
    '🤦','🤷','💆','💇','🚶','🧍','🧎','🏃','💃','🕺',
    '👯','🧖','🛀','🛌','👭','👫','👬','💏','💑','👪',
  ],
  'Animals': [
    '🐶','🐱','🐭','🐹','🐰','🦊','🐻','🐼','🐻‍❄️','🐨',
    '🐯','🦁','🐮','🐷','🐸','🐵','🙈','🙉','🙊','🐒',
    '🐔','🐧','🐦','🐤','🦆','🦅','🦉','🦇','🐺','🐗',
    '🐴','🦄','🐝','🪱','🐛','🦋','🐌','🐞','🐜','🪲',
    '🦗','🕷️','🦂','🐢','🐍','🦎','🦖','🦕','🐙','🦑',
    '🦐','🦞','🦀','🐡','🐠','🐟','🐬','🐳','🐋','🦈',
    '🐊','🐅','🐆','🦓','🦍','🦧','🐘','🦛','🦏','🐪',
  ],
  'Food': [
    '🍏','🍎','🍐','🍊','🍋','🍌','🍉','🍇','🍓','🫐',
    '🍈','🍒','🍑','🥭','🍍','🥥','🥝','🍅','🍆','🥑',
    '🫛','🥦','🥬','🥒','🌶️','🫑','🌽','🥕','🫒','🧄',
    '🧅','🥔','🍠','🫚','🥐','🥯','🍞','🥖','🥨','🧀',
    '🥚','🍳','🧈','🥞','🧇','🥓','🥩','🍗','🍖','🌭',
    '🍔','🍟','🍕','🫓','🥪','🥙','🧆','🌮','🌯','🫔',
    '🥗','🥘','🫕','🍝','🍜','🍲','🍛','🍣','🍱','🥟',
    '🦪','🍤','🍙','🍚','🍘','🍥','🥠','🥮','🍢','🍡',
    '🍧','🍨','🍦','🥧','🧁','🍰','🎂','🍮','🍭','🍬',
    '🍫','🍿','🍩','🍪','🌰','🥜','🫘','🍯',
  ],
  'Travel': [
    '🚗','🚕','🚙','🚌','🚎','🏎️','🚓','🚑','🚒','🚐',
    '🛻','🚚','🚛','🚜','🏍️','🛵','🚲','🛴','🛹','🛼',
    '🚁','🛸','🚀','🛩️','✈️','🚢','⛵','🚤','🛥️','🛳️',
    '🏠','🏡','🏢','🏣','🏥','🏦','🏨','🏩','🏪','🏫',
    '⛪','🕌','🕍','⛩️','🕋','⛲','⛺','🌁','🌃','🌄',
    '🌅','🌆','🌇','🌉','🎠','🎡','🎢','🚂','🚃','🚄',
  ],
  'Objects': [
    '⌚','📱','💻','⌨️','🖥️','🖨️','🖱️','🖲️','💽','💾',
    '📷','📸','📹','🎥','📽️','🎞️','📞','☎️','📺','📻',
    '🎵','🎶','🎹','🥁','🎷','🎺','🎸','🪕','🎻','📚',
    '📖','📝','✏️','🖊️','🖋️','✒️','📌','📎','🔗','📐',
    '📏','🗑️','🔒','🔓','🔑','🗝️','🔨','🪓','⛏️','🔧',
    '🔩','💡','🔦','🕯️','💰','💳','💎','⚖️','🧰','🔬',
    '🔭','📡','💉','💊','🩹','🩺','🚪','🛁','🧹','🧺',
  ],
  'Symbols': [
    '❤️','🧡','💛','💚','💙','💜','🖤','🤍','🤎','💔',
    '❤️‍🔥','❤️‍🩹','💕','💞','💓','💗','💖','💘','💝','💟',
    '☮️','✝️','☪️','🕉️','☸️','✡️','🔯','🕎','☯️','☦️',
    '♈','♉','♊','♋','♌','♍','♎','♏','♐','♑',
    '♒','♓','⛎','🔀','🔁','🔂','▶️','⏩','⏭️','⏸️',
    '⏹️','⏺️','⏏️','🔅','🔆','📶','📳','📴','♻️','🔰',
    '✅','❌','❓','❗','‼️','⁉️','💯','🔴','🟠','🟡',
    '🟢','🔵','🟣','⚫','⚪','🟤','🔶','🔷','🔸','🔹',
  ],
  'Flags': [
    '🏁','🚩','🎌','🏴','🏳️','🏳️‍🌈','🏳️‍⚧️','🏴‍☠️',
    '🇺🇸','🇬🇧','🇫🇷','🇩🇪','🇮🇹','🇪🇸','🇯🇵','🇰🇷',
    '🇨🇳','🇮🇳','🇧🇷','🇷🇺','🇨🇦','🇦🇺','🇲🇽','🇿🇦',
    '🇳🇬','🇪🇬','🇰🇪','🇸🇦','🇦🇪','🇹🇷','🇸🇪','🇳🇴',
    '🇩🇰','🇫🇮','🇳🇱','🇧🇪','🇨🇭','🇦🇹','🇵🇱','🇨🇿',
    '🇺🇦','🇬🇷','🇵🇹','🇮🇪','🇮🇱','🇵🇭','🇹🇭','🇻🇳',
    '🇮🇩','🇲🇾','🇸🇬','🇳🇿','🇦🇷','🇨🇱','🇨🇴','🇵🇪',
  ],
};

const CATEGORY_ICONS: Record<string, string> = {
  'Recently Used': '🕐',
  'Smileys': '😀',
  'Gestures': '👋',
  'People': '👤',
  'Animals': '🐾',
  'Food': '🍔',
  'Travel': '🚗',
  'Objects': '💡',
  'Symbols': '❤️',
  'Flags': '🏁',
};

const RECENT_KEY = 'rocchat_recent_emoji';
const MAX_RECENT = 32;

function getRecent(): string[] {
  try {
    return JSON.parse(localStorage.getItem(RECENT_KEY) || '[]');
  } catch { return []; }
}

function addRecent(emoji: string) {
  const recent = getRecent().filter(e => e !== emoji);
  recent.unshift(emoji);
  if (recent.length > MAX_RECENT) recent.length = MAX_RECENT;
  localStorage.setItem(RECENT_KEY, JSON.stringify(recent));
}

export function initEmojiPicker(
  container: HTMLElement,
  toggleBtn: HTMLElement,
  onSelect: (emoji: string) => void,
) {
  let visible = false;
  let activeCategory = 'Smileys';

  function render() {
    const recent = getRecent();
    const cats: Record<string, string[]> = { ...CATEGORIES };
    if (recent.length > 0) cats['Recently Used'] = recent;

    const catNames = Object.keys(cats);
    if (!cats[activeCategory]) activeCategory = catNames[0];

    const emojis = cats[activeCategory] || [];

    container.innerHTML = `
      <div class="emoji-picker-search">
        <input type="text" class="emoji-search-input" placeholder="Search emoji\u2026" aria-label="Search emoji" />
      </div>
      <div class="emoji-picker-tabs">
        ${catNames.map(c => `<button class="emoji-tab ${c === activeCategory ? 'active' : ''}" data-cat="${c}" title="${c}">${CATEGORY_ICONS[c] || '\uD83D\uDCC1'}</button>`).join('')}
      </div>
      <div class="emoji-picker-grid">
        ${emojis.map((e: string) => `<button class="emoji-item" data-emoji="${e}">${e}</button>`).join('')}
      </div>
    `;

    // Tab clicks
    container.querySelectorAll('.emoji-tab').forEach(btn => {
      btn.addEventListener('click', () => {
        activeCategory = (btn as HTMLElement).dataset.cat || 'Smileys';
        render();
      });
    });

    // Emoji clicks
    container.querySelectorAll('.emoji-item').forEach(btn => {
      btn.addEventListener('click', () => {
        const emoji = (btn as HTMLElement).dataset.emoji || '';
        addRecent(emoji);
        onSelect(emoji);
      });
    });

    // Search
    const searchInput = container.querySelector('.emoji-search-input') as HTMLInputElement;
    if (searchInput) {
      searchInput.addEventListener('input', () => {
        const q = searchInput.value.toLowerCase().trim();
        if (!q) { render(); return; }
        // Search through all emojis (basic: just show matching from all categories)
        const allEmojis = Object.values(CATEGORIES).flat();
        const grid = container.querySelector('.emoji-picker-grid') as HTMLElement;
        if (grid) {
          // Simple filter — since we can't search by name, just re-show all (search is visual only for now)
          grid.innerHTML = allEmojis.map(e =>
            `<button class="emoji-item" data-emoji="${e}">${e}</button>`
          ).join('');
          grid.querySelectorAll('.emoji-item').forEach(btn => {
            btn.addEventListener('click', () => {
              const emoji = (btn as HTMLElement).dataset.emoji || '';
              addRecent(emoji);
              onSelect(emoji);
            });
          });
        }
      });
    }
  }

  toggleBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    visible = !visible;
    container.style.display = visible ? 'block' : 'none';
    toggleBtn.setAttribute('aria-expanded', String(visible));
    if (visible) render();
  });

  // Close on outside click
  document.addEventListener('click', (e) => {
    if (visible && !container.contains(e.target as Node) && e.target !== toggleBtn) {
      visible = false;
      container.style.display = 'none';
      toggleBtn.setAttribute('aria-expanded', 'false');
    }
  });
}
