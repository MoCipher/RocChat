/**
 * RocChat — ⌘K command palette (lightweight, no deps).
 *
 * Mounted lazily from app.ts on first ⌘K / Ctrl+K.
 */

export interface PaletteCommand {
  id: string;
  label: string;
  hint?: string;
  shortcut?: string;
  action: () => void | Promise<void>;
}

let commands: PaletteCommand[] = [];
let openEl: HTMLDivElement | null = null;

export function registerPaletteCommand(cmd: PaletteCommand): void {
  commands = commands.filter((c) => c.id !== cmd.id).concat(cmd);
}

export function unregisterPaletteCommand(id: string): void {
  commands = commands.filter((c) => c.id !== id);
}

export function openPalette(): void {
  if (openEl) return;
  const backdrop = document.createElement('div');
  backdrop.className = 'cmdk-backdrop';
  backdrop.setAttribute('role', 'dialog');
  backdrop.setAttribute('aria-modal', 'true');
  backdrop.setAttribute('aria-label', 'Command palette');
  const panel = document.createElement('div');
  panel.className = 'cmdk-panel';
  const input = document.createElement('input');
  input.className = 'cmdk-input';
  input.type = 'text';
  input.placeholder = 'Type a command…';
  input.setAttribute('aria-label', 'Command');
  input.autocomplete = 'off';
  input.spellcheck = false;
  const list = document.createElement('div');
  list.className = 'cmdk-list';
  list.setAttribute('role', 'listbox');
  panel.append(input, list);
  backdrop.append(panel);
  document.body.append(backdrop);
  openEl = backdrop;

  let selected = 0;
  const render = () => {
    const q = input.value.trim().toLowerCase();
    const items = commands
      .filter((c) => !q || c.label.toLowerCase().includes(q) || c.hint?.toLowerCase().includes(q))
      .slice(0, 50);
    list.replaceChildren();
    if (items.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'cmdk-empty';
      empty.textContent = q ? 'No matches' : 'No commands available yet';
      list.append(empty);
      return;
    }
    items.forEach((cmd, i) => {
      const row = document.createElement('div');
      row.className = 'cmdk-item';
      row.setAttribute('role', 'option');
      row.setAttribute('aria-selected', i === selected ? 'true' : 'false');
      row.dataset.idx = String(i);
      const label = document.createElement('span');
      label.textContent = cmd.label;
      row.append(label);
      if (cmd.shortcut) {
        const kbd = document.createElement('kbd');
        kbd.className = 'cmdk-shortcut';
        kbd.textContent = cmd.shortcut;
        row.append(kbd);
      }
      row.addEventListener('click', () => { void run(cmd); });
      list.append(row);
    });
  };

  const close = () => {
    backdrop.remove();
    openEl = null;
    document.removeEventListener('keydown', onKey, true);
  };

  const run = async (cmd: PaletteCommand) => {
    close();
    try { await cmd.action(); } catch (e) { console.error('palette command failed', e); }
  };

  const onKey = (e: KeyboardEvent) => {
    if (e.key === 'Escape') { e.preventDefault(); close(); return; }
    const items = list.querySelectorAll<HTMLElement>('.cmdk-item');
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      selected = Math.min(selected + 1, items.length - 1);
      items.forEach((el, i) => el.setAttribute('aria-selected', i === selected ? 'true' : 'false'));
      items[selected]?.scrollIntoView({ block: 'nearest' });
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      selected = Math.max(selected - 1, 0);
      items.forEach((el, i) => el.setAttribute('aria-selected', i === selected ? 'true' : 'false'));
      items[selected]?.scrollIntoView({ block: 'nearest' });
    } else if (e.key === 'Enter') {
      e.preventDefault();
      const idx = selected;
      const q = input.value.trim().toLowerCase();
      const filtered = commands.filter((c) => !q || c.label.toLowerCase().includes(q) || c.hint?.toLowerCase().includes(q));
      const cmd = filtered[idx];
      if (cmd) void run(cmd);
    }
  };

  document.addEventListener('keydown', onKey, true);
  backdrop.addEventListener('click', (e) => { if (e.target === backdrop) close(); });
  input.addEventListener('input', () => { selected = 0; render(); });
  render();
  setTimeout(() => input.focus(), 0);
}

export function installCommandPaletteHotkey(): void {
  window.addEventListener('keydown', (e) => {
    const isCmdK = (e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k';
    if (!isCmdK) return;
    // Avoid hijacking when typing in an editable element with a value (allow ⌘K-in-textbox to open as well).
    e.preventDefault();
    openPalette();
  });
}
