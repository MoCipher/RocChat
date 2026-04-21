/**
 * RocChat Web — Landing Page
 *
 * Hero with Roc bird, download CTAs for iOS/Android,
 * "Use Web" option via QR code scan from mobile app.
 */

import { parseHTML } from '../utils.js';

const ROC_BIRD_SVG = `<svg viewBox="0 0 512 512" width="120" height="120">
  <defs>
    <linearGradient id="lbg" x1="0%" y1="0%" x2="100%" y2="100%">
      <stop offset="0%" stop-color="#0D1117"/><stop offset="40%" stop-color="#161B22"/><stop offset="100%" stop-color="#0D1117"/>
    </linearGradient>
    <radialGradient id="lglow" cx="50%" cy="40%" r="55%">
      <stop offset="0%" stop-color="#D4AF37" stop-opacity="0.2"/><stop offset="100%" stop-color="transparent"/>
    </radialGradient>
    <linearGradient id="lbody" x1="30%" y1="0%" x2="70%" y2="100%">
      <stop offset="0%" stop-color="#fef3c7"/><stop offset="40%" stop-color="#f59e0b"/><stop offset="100%" stop-color="#b45309"/>
    </linearGradient>
    <linearGradient id="lwL" x1="100%" y1="30%" x2="0%" y2="80%">
      <stop offset="0%" stop-color="#fbbf24"/><stop offset="35%" stop-color="#d97706"/><stop offset="70%" stop-color="#92400e"/><stop offset="100%" stop-color="#451a03"/>
    </linearGradient>
    <linearGradient id="lwR" x1="0%" y1="30%" x2="100%" y2="80%">
      <stop offset="0%" stop-color="#fbbf24"/><stop offset="35%" stop-color="#d97706"/><stop offset="70%" stop-color="#92400e"/><stop offset="100%" stop-color="#451a03"/>
    </linearGradient>
    <linearGradient id="ltail" x1="50%" y1="0%" x2="50%" y2="100%">
      <stop offset="0%" stop-color="#d97706"/><stop offset="100%" stop-color="#78350f"/>
    </linearGradient>
    <linearGradient id="lhead" x1="30%" y1="0%" x2="70%" y2="100%">
      <stop offset="0%" stop-color="#fffbeb"/><stop offset="100%" stop-color="#fbbf24"/>
    </linearGradient>
    <filter id="lds" x="-5%" y="-5%" width="110%" height="110%">
      <feDropShadow dx="0" dy="2" stdDeviation="6" flood-color="#0D1117" flood-opacity="0.5"/>
    </filter>
  </defs>
  <rect width="512" height="512" rx="112" fill="url(#lbg)"/>
  <rect width="512" height="512" rx="112" fill="url(#lglow)"/>
  <rect x="4" y="4" width="504" height="504" rx="110" fill="none" stroke="rgba(212,175,55,0.15)" stroke-width="2"/>
  <g transform="translate(256,250)" filter="url(#lds)">
    <path d="M-18,-15 C-50,-55 -95,-100 -155,-130 C-168,-135 -185,-132 -195,-125 C-180,-110 -160,-95 -140,-80 C-160,-90 -182,-95 -200,-92 C-185,-75 -165,-60 -140,-48 C-158,-55 -175,-55 -192,-50 C-170,-35 -148,-22 -120,-15 C-138,-18 -155,-18 -168,-12 C-145,-2 -118,5 -85,8 C-55,10 -30,2 -15,-5 Z" fill="url(#lwL)"/>
    <path d="M18,-15 C50,-55 95,-100 155,-130 C168,-135 185,-132 195,-125 C180,-110 160,-95 140,-80 C160,-90 182,-95 200,-92 C185,-75 165,-60 140,-48 C158,-55 175,-55 192,-50 C170,-35 148,-22 120,-15 C138,-18 155,-18 168,-12 C145,-2 118,5 85,8 C55,10 30,2 15,-5 Z" fill="url(#lwR)"/>
    <ellipse cx="0" cy="18" rx="26" ry="52" fill="url(#lbody)"/>
    <ellipse cx="0" cy="5" rx="16" ry="28" fill="#fef3c7" opacity="0.4"/>
    <path d="M-10,65 C-18,90 -35,125 -52,150 C-38,140 -22,120 -12,95 C-15,115 -20,138 -28,155 C-14,145 -4,125 0,100 C4,125 14,145 28,155 C20,138 15,115 12,95 C22,120 38,140 52,150 C35,125 18,90 10,65 Z" fill="url(#ltail)" opacity="0.9"/>
    <ellipse cx="0" cy="-42" rx="19" ry="21" fill="url(#lhead)"/>
    <path d="M-3,-62 C-6,-78 -2,-88 0,-92 C2,-88 6,-78 3,-62" fill="#d97706" opacity="0.8"/>
    <ellipse cx="-7" cy="-44" rx="4" ry="4.5" fill="#fffbeb"/>
    <ellipse cx="7" cy="-44" rx="4" ry="4.5" fill="#fffbeb"/>
    <ellipse cx="-7" cy="-44" rx="2.5" ry="3" fill="#78350f"/>
    <ellipse cx="7" cy="-44" rx="2.5" ry="3" fill="#78350f"/>
    <circle cx="-6.5" cy="-45" r="1" fill="white" opacity="0.8"/>
    <circle cx="7.5" cy="-45" r="1" fill="white" opacity="0.8"/>
    <path d="M0,-36 L-4,-28 C-2,-24 2,-24 4,-28 L0,-36 Z" fill="#92400e"/>
    <g transform="translate(-14,68)"><path d="M0,0 C-3,8 -8,14 -12,18 M0,0 C-1,9 -4,16 -6,20 M0,0 C1,9 0,17 -1,22" fill="none" stroke="#78350f" stroke-width="2.2" stroke-linecap="round"/></g>
    <g transform="translate(14,68)"><path d="M0,0 C3,8 8,14 12,18 M0,0 C1,9 4,16 6,20 M0,0 C-1,9 0,17 1,22" fill="none" stroke="#78350f" stroke-width="2.2" stroke-linecap="round"/></g>
  </g>
</svg>`;

export function renderLanding(container: HTMLElement, onWebLogin: () => void) {
  container.replaceChildren(parseHTML(`
    <div class="landing">
      <nav class="landing-nav">
        <div class="landing-nav-brand">
          ${ROC_BIRD_SVG.replace('width="120" height="120"', 'width="36" height="36"')}
          <span class="landing-nav-name">RocChat</span>
        </div>
        <div class="landing-nav-links">
          <a href="#features">Features</a>
          <a href="#security">Security</a>
          <a href="#download">Download</a>
        </div>
      </nav>

      <section class="landing-hero">
        <div class="landing-hero-bird">${ROC_BIRD_SVG}</div>
        <h1 class="landing-hero-title">RocChat</h1>
        <p class="landing-hero-tagline">Messages. Calls. Nothing else.<br/>Everything encrypted.</p>
        <p class="landing-hero-sub">No phone number. No compromise.</p>
        <div class="landing-hero-actions">
          <a href="#download" class="btn-primary landing-btn">
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>
            Download App
          </a>
          <button class="btn-secondary landing-btn" id="use-web-btn">
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="3" width="20" height="14" rx="2" ry="2"/><line x1="8" y1="21" x2="16" y2="21"/><line x1="12" y1="17" x2="12" y2="21"/></svg>
            Use Web Version
          </button>
        </div>
      </section>

      <section class="landing-features" id="features">
        <h2 class="landing-section-title">Just messaging, done perfectly.</h2>
        <div class="landing-features-grid">
          <div class="landing-feature-card">
            <div class="landing-feature-icon">
              <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="var(--roc-gold)" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="11" width="18" height="11" rx="2" ry="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/></svg>
            </div>
            <h3>End-to-End Encrypted</h3>
            <p>Double Ratchet + X3DH. Every message, every call, every file. Always encrypted. Zero exceptions.</p>
          </div>
          <div class="landing-feature-card">
            <div class="landing-feature-icon">
              <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="var(--roc-gold)" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/></svg>
            </div>
            <h3>No Phone Number</h3>
            <p>Sign up with a username and passphrase. No phone, no email, no data harvesting. Truly anonymous.</p>
          </div>
          <div class="landing-feature-card">
            <div class="landing-feature-icon">
              <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="var(--roc-gold)" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6 19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72c.127.96.361 1.903.7 2.81a2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45c.907.339 1.85.573 2.81.7A2 2 0 0 1 22 16.92z"/></svg>
            </div>
            <h3>Voice & Video Calls</h3>
            <p>Crystal-clear encrypted calls. Peer-to-peer. No intermediary servers can listen in.</p>
          </div>
          <div class="landing-feature-card">
            <div class="landing-feature-icon">
              <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="var(--roc-gold)" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="4" y="4" width="16" height="16" rx="2" ry="2"/><rect x="9" y="9" width="6" height="6"/><line x1="9" y1="1" x2="9" y2="4"/><line x1="15" y1="1" x2="15" y2="4"/><line x1="9" y1="20" x2="9" y2="23"/><line x1="15" y1="20" x2="15" y2="23"/><line x1="20" y1="9" x2="23" y2="9"/><line x1="20" y1="14" x2="23" y2="14"/><line x1="1" y1="9" x2="4" y2="9"/><line x1="1" y1="14" x2="4" y2="14"/></svg>
            </div>
            <h3>True Multi-Device</h3>
            <p>Every device is equal. No primary phone required. Add or revoke devices anytime. No SIM swap risk.</p>
          </div>
          <div class="landing-feature-card">
            <div class="landing-feature-icon">
              <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="var(--roc-gold)" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><line x1="2" y1="12" x2="22" y2="12"/><path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z"/></svg>
            </div>
            <h3>Open Source</h3>
            <p>Fully open source. Reproducible builds. Annual security audits. Verify everything yourself.</p>
          </div>
          <div class="landing-feature-card">
            <div class="landing-feature-icon">
              <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="var(--roc-gold)" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/></svg>
            </div>
            <h3>Disappearing Messages</h3>
            <p>Messages, media, voice notes — set to auto-delete. Ghost Mode for maximum privacy.</p>
          </div>
        </div>
      </section>

      <section class="landing-security" id="security">
        <h2 class="landing-section-title">Built for the paranoid.</h2>
        <div class="landing-trust-numbers">
          <div class="landing-trust-stat">
            <span class="landing-trust-num">256</span>
            <span class="landing-trust-label">bit AES-GCM encryption</span>
          </div>
          <div class="landing-trust-stat">
            <span class="landing-trust-num">600K</span>
            <span class="landing-trust-label">PBKDF2 rounds</span>
          </div>
          <div class="landing-trust-stat">
            <span class="landing-trust-num">0</span>
            <span class="landing-trust-label">metadata stored</span>
          </div>
          <div class="landing-trust-stat">
            <span class="landing-trust-num">100%</span>
            <span class="landing-trust-label">open source</span>
          </div>
        </div>
        <div class="landing-security-grid">
          <div class="landing-security-item">
            <span class="landing-security-tag">Protocol</span>
            <p>Double Ratchet + X3DH (same foundation as Signal)</p>
          </div>
          <div class="landing-security-item">
            <span class="landing-security-tag">Encryption</span>
            <p>AES-256-GCM symmetric, X25519 key exchange, Ed25519 signatures</p>
          </div>
          <div class="landing-security-item">
            <span class="landing-security-tag">Auth</span>
            <p>Zero-knowledge passphrase. PBKDF2 600K rounds. Server never sees your password.</p>
          </div>
          <div class="landing-security-item">
            <span class="landing-security-tag">Calls</span>
            <p>DTLS-SRTP peer-to-peer. Media never touches our servers.</p>
          </div>
          <div class="landing-security-item">
            <span class="landing-security-tag">Storage</span>
            <p>All data encrypted at rest. We can't read your messages even with a court order.</p>
          </div>
          <div class="landing-security-item">
            <span class="landing-security-tag">Audit</span>
            <p>Open source. Reproducible builds. Annual third-party security audits.</p>
          </div>
        </div>
      </section>

      <section class="landing-download" id="download">
        <h2 class="landing-section-title">Get RocChat</h2>
        <p class="landing-download-sub">Available on every platform. Same account everywhere.</p>
        <div class="landing-download-grid">
          <a class="landing-download-card" href="#" target="_blank" rel="noopener">
            <svg width="36" height="36" viewBox="0 0 24 24" fill="var(--text-primary)"><path d="M18.71 19.5c-.83 1.24-1.71 2.45-3.05 2.47-1.34.03-1.77-.79-3.29-.79-1.53 0-2 .77-3.27.82-1.31.05-2.3-1.32-3.14-2.53C4.25 17 2.94 12.45 4.7 9.39c.87-1.52 2.43-2.48 4.12-2.51 1.28-.02 2.5.87 3.29.87.78 0 2.26-1.07 3.8-.91.65.03 2.47.26 3.64 1.98-.09.06-2.17 1.28-2.15 3.81.03 3.02 2.65 4.03 2.68 4.04-.03.07-.42 1.44-1.38 2.83M13 3.5c.73-.83 1.94-1.46 2.94-1.5.13 1.17-.34 2.35-1.04 3.19-.69.85-1.83 1.51-2.95 1.42-.15-1.15.41-2.35 1.05-3.11z"/></svg>
            <div>
              <span class="landing-download-label">Download on the</span>
              <span class="landing-download-store">App Store</span>
            </div>
          </a>
          <a class="landing-download-card" href="#" target="_blank" rel="noopener">
            <svg width="36" height="36" viewBox="0 0 24 24" fill="var(--text-primary)"><path d="M3.609 1.814L13.792 12 3.61 22.186a.996.996 0 0 1-.61-.92V2.734a1 1 0 0 1 .609-.92zm10.89 10.893l2.302 2.302-10.937 6.333 8.635-8.635zm3.199-3.199l2.302 2.302a1 1 0 0 1 0 1.38l-2.302 2.302L15.24 12l2.458-2.492zM5.864 2.658L16.8 8.991l-2.302 2.302L5.864 2.658z"/></svg>
            <div>
              <span class="landing-download-label">GET IT ON</span>
              <span class="landing-download-store">Google Play</span>
            </div>
          </a>
          <button class="landing-download-card" id="web-login-btn">
            <svg width="36" height="36" viewBox="0 0 24 24" fill="none" stroke="var(--text-primary)" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="3" width="20" height="14" rx="2" ry="2"/><line x1="8" y1="21" x2="16" y2="21"/><line x1="12" y1="17" x2="12" y2="21"/></svg>
            <div>
              <span class="landing-download-label">USE ON</span>
              <span class="landing-download-store">Web Browser</span>
            </div>
          </button>
        </div>
      </section>

      <footer class="landing-footer">
        <div class="landing-footer-inner">
          <div class="landing-footer-brand">
            ${ROC_BIRD_SVG.replace('width="120" height="120"', 'width="28" height="28"')}
            <span>RocChat</span>
          </div>
          <div class="landing-footer-links">
            <span>Part of the <strong>Roc Family</strong></span>
            <span class="landing-footer-sep">·</span>
            <a href="https://mail.mocipher.com" target="_blank" rel="noopener">RocMail</a>
            <span class="landing-footer-sep">·</span>
            <a href="https://pass.mocipher.com" target="_blank" rel="noopener">RocPass</a>
          </div>
          <p class="landing-footer-copy">Open source. Audited. Private by design.</p>
        </div>
      </footer>
    </div>
  `));

  // Bind web login buttons
  container.querySelector('#use-web-btn')?.addEventListener('click', onWebLogin);
  container.querySelector('#web-login-btn')?.addEventListener('click', onWebLogin);

  // Smooth scroll for anchor links
  container.querySelectorAll('a[href^="#"]').forEach((a) => {
    a.addEventListener('click', (e) => {
      const href = (a as HTMLAnchorElement).getAttribute('href');
      if (href && href.startsWith('#')) {
        e.preventDefault();
        const target = document.querySelector(href);
        target?.scrollIntoView({ behavior: 'smooth' });
      }
    });
  });
}
