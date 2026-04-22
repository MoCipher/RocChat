export function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c] || c));
}

// Global delegated error handler for avatar images.
// Instead of inline onerror="...", mark images with data-fallback="XY"
// and this listener replaces the broken image with the fallback text.
let _avatarFallbackInstalled = false;
export function installAvatarFallback(): void {
  if (_avatarFallbackInstalled) return;
  _avatarFallbackInstalled = true;
  document.addEventListener('error', (e) => {
    const el = e.target as HTMLElement;
    if (el.tagName !== 'IMG') return;
    // Pattern 1: data-fallback="XY" — replace parent content with initials
    const fallback = el.getAttribute('data-fallback');
    if (fallback) {
      const parent = el.parentElement;
      if (parent) parent.textContent = fallback;
      return;
    }
    // Pattern 2: data-fallback-show-next — hide img, show next sibling
    if (el.hasAttribute('data-fallback-show-next')) {
      el.style.display = 'none';
      const next = el.nextElementSibling as HTMLElement | null;
      if (next) next.style.display = 'flex';
    }
  }, true); // capture phase to catch img errors
}

/**
 * Parse a developer-controlled HTML string using DOMParser and return a
 * DocumentFragment. The 'default' Trusted Types policy (registered in
 * app.ts) auto-wraps the raw string at the DOMParser sink — no manual
 * wrapping needed here.
 *
 * Usage: el.replaceChildren(parseHTML(`<div>...</div>`));
 */
/** Trigger a short haptic vibration on mobile PWA. No-op on desktop. */
export function haptic(ms: number | number[] = 10): void {
  try { navigator.vibrate?.(ms); } catch { /* unsupported */ }
}

export function parseHTML(html: string): DocumentFragment {
  const doc = new DOMParser().parseFromString(html, 'text/html');
  const frag = document.createDocumentFragment();
  Array.from(doc.body.childNodes).forEach((n) => frag.appendChild(n));
  return frag;
}
