export function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c] || c));
}

// Global delegated error handler for avatar images.
// Instead of inline onerror="...", mark images with data-fallback="XY"
// and this listener replaces the broken image with the fallback text.
// Also handles E2E-encrypted avatars: if an avatar img fails because the
// server returned an encrypted blob (application/octet-stream), we fetch
// the URL via JS, decrypt with the vault key, and replace the src.
let _avatarFallbackInstalled = false;
const _decryptingAvatars = new Set<string>();
export function installAvatarFallback(): void {
  if (_avatarFallbackInstalled) return;
  _avatarFallbackInstalled = true;
  document.addEventListener('error', (e) => {
    const el = e.target as HTMLElement;
    if (el.tagName !== 'IMG') return;
    const img = el as HTMLImageElement;
    const src = img.src;

    // Try E2E avatar decryption if the URL looks like an avatar endpoint
    if (src.includes('/me/avatar/') && !_decryptingAvatars.has(src)) {
      _decryptingAvatars.add(src);
      tryDecryptAvatar(img, src).catch(() => {
        showFallback(img);
      });
      return;
    }

    showFallback(img);
  }, true); // capture phase to catch img errors
}

function showFallback(img: HTMLImageElement): void {
  const fallback = img.getAttribute('data-fallback');
  if (fallback) {
    const parent = img.parentElement;
    if (parent) parent.textContent = fallback;
    return;
  }
  if (img.hasAttribute('data-fallback-show-next')) {
    img.style.display = 'none';
    const next = img.nextElementSibling as HTMLElement | null;
    if (next) next.style.display = 'flex';
  }
}

async function tryDecryptAvatar(img: HTMLImageElement, src: string): Promise<void> {
  try {
    const res = await fetch(src);
    if (!res.ok) { showFallback(img); return; }
    const ct = res.headers.get('content-type') || '';
    if (ct.startsWith('image/')) {
      // Not encrypted — just a transient load error, retry
      const blob = await res.blob();
      img.src = URL.createObjectURL(blob);
      return;
    }
    const { decryptAvatarBlob } = await import('./crypto/profile-crypto.js');
    const encrypted = await res.arrayBuffer();
    const decrypted = await decryptAvatarBlob(encrypted);
    if (decrypted) {
      const blob = new Blob([decrypted], { type: 'image/jpeg' });
      img.src = URL.createObjectURL(blob);
    } else {
      showFallback(img);
    }
  } catch {
    showFallback(img);
  }
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
