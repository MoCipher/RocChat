export function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c] || c));
}

/**
 * Parse a developer-controlled HTML string using DOMParser and return a
 * DocumentFragment. DOMParser.parseFromString is NOT a Trusted Types sink,
 * so this can be used anywhere innerHTML would otherwise be needed for
 * static/templated UI markup (not user-supplied content).
 *
 * Usage: el.replaceChildren(parseHTML(`<div>...</div>`));
 */
export function parseHTML(html: string): DocumentFragment {
  const doc = new DOMParser().parseFromString(html, 'text/html');
  const frag = document.createDocumentFragment();
  Array.from(doc.body.childNodes).forEach((n) => frag.appendChild(n));
  return frag;
}
