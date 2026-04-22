export function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c] || c));
}

/**
 * Parse a developer-controlled HTML string using DOMParser and return a
 * DocumentFragment. DOMParser.parseFromString IS a Trusted Types sink, so
 * we use the 'rocchat-default' policy (registered in app.ts) to wrap the
 * string when Trusted Types are enforced.
 *
 * Usage: el.replaceChildren(parseHTML(`<div>...</div>`));
 */
export function parseHTML(html: string): DocumentFragment {
  let input: unknown = html;
  try {
    const tt = (window as unknown as { trustedTypes?: { defaultPolicy?: { createHTML: (s: string) => unknown } } }).trustedTypes;
    if (tt?.defaultPolicy?.createHTML) {
      input = tt.defaultPolicy.createHTML(html);
    }
  } catch { /* TT unavailable — pass raw string */ }
  const doc = new DOMParser().parseFromString(input as string, 'text/html');
  const frag = document.createDocumentFragment();
  Array.from(doc.body.childNodes).forEach((n) => frag.appendChild(n));
  return frag;
}
