export function showToast(message: string, type: 'success' | 'error' | 'info' = 'info') {
  let container = document.querySelector('.toast-container') as HTMLElement | null;
  if (!container) {
    container = document.createElement('div');
    container.className = 'toast-container';
    container.setAttribute('role', 'alert');
    container.setAttribute('aria-live', 'polite');
    document.body.appendChild(container);
  }
  const toast = document.createElement('div');
  toast.className = `toast toast-${type}`;
  toast.textContent = message;
  container.appendChild(toast);
  setTimeout(() => {
    toast.classList.add('toast-exit');
    toast.addEventListener('animationend', () => toast.remove());
  }, 3000);
}
