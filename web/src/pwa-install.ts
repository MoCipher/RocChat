/**
 * RocChat Web — PWA Install Prompts
 *
 * Chromium: listens for `beforeinstallprompt` and stashes the event for
 * manual display via a Settings / banner button.
 *
 * iOS Safari: does NOT support `beforeinstallprompt`. The user must use
 * the native Share → "Add to Home Screen" menu. We detect iOS standalone
 * vs browser mode and show a dismissible explainer banner the first time
 * an iOS Safari user visits.
 */

type InstallPromptEvent = Event & {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }>;
};

let deferredPrompt: InstallPromptEvent | null = null;

export function initInstallPrompts(): void {
  // ── Chromium / Android ──
  window.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault();
    deferredPrompt = e as InstallPromptEvent;
    // Expose a hook so Settings can call triggerInstall().
    document.body.dataset.canInstall = '1';
  });

  // ── iOS Safari (separate flow) ──
  const isIos = /iPad|iPhone|iPod/.test(navigator.userAgent) && !(window as unknown as { MSStream?: unknown }).MSStream;
  const isStandalone = (navigator as Navigator & { standalone?: boolean }).standalone === true;
  const dismissed = localStorage.getItem('rocchat_ios_install_dismissed') === '1';
  if (isIos && !isStandalone && !dismissed) {
    showIosInstallBanner();
  }
}

export async function triggerInstall(): Promise<boolean> {
  if (!deferredPrompt) return false;
  await deferredPrompt.prompt();
  const choice = await deferredPrompt.userChoice;
  deferredPrompt = null;
  delete document.body.dataset.canInstall;
  return choice.outcome === 'accepted';
}

function showIosInstallBanner(): void {
  if (document.getElementById('rc-ios-install-banner')) return;
  const el = document.createElement('div');
  el.id = 'rc-ios-install-banner';
  el.setAttribute('role', 'region');
  el.setAttribute('aria-label', 'Install RocChat on iOS');
  el.innerHTML = `
    <div class="rc-ios-install-inner">
      <div class="rc-ios-install-text">
        <strong>Install RocChat</strong>
        <span>Tap <span aria-label="Share">
          <svg width="14" height="14" viewBox="0 0 20 20" fill="currentColor" aria-hidden="true">
            <path d="M10 2 6 6h3v7h2V6h3l-4-4zM4 14v4h12v-4h-2v2H6v-2H4z"/>
          </svg>
        </span> then <em>Add to Home Screen</em></span>
      </div>
      <button type="button" class="rc-ios-install-close" aria-label="Dismiss">&times;</button>
    </div>`;
  document.body.appendChild(el);
  el.querySelector('.rc-ios-install-close')?.addEventListener('click', () => {
    localStorage.setItem('rocchat_ios_install_dismissed', '1');
    el.remove();
  });
}
