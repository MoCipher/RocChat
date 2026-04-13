/**
 * RocChat Web — Auth UI
 *
 * Login and registration screens. Zero-knowledge: passphrase never leaves device.
 */

import * as api from '../api.js';
import {
  deriveAuthHash,
  deriveVaultKey,
  generateKeyBundle,
  encryptPrivateKeys,
  storeKeysLocally,
  generateSalt,
  decryptPrivateKeys,
} from '../crypto/client-crypto.js';
import { toBase64, fromBase64, generateX25519KeyPair } from '@rocchat/shared';
import { generateRecoveryPhrase } from '../crypto/recovery-phrase.js';
import { setKeyMaterial } from '../crypto/session-manager.js';

export function renderAuth(container: HTMLElement, onSuccess: () => void) {
  let mode: 'login' | 'register' = 'login';

  function render() {
    container.innerHTML = `
      <div class="auth-screen">
        <div class="auth-card">
          <div class="auth-logo">
            <img src="/favicon.svg" width="64" height="64" alt="RocChat" />
            <h1>RocChat</h1>
            <p>End-to-end encrypted messaging</p>
          </div>

          <div id="auth-error" class="alert-error hidden"></div>

          ${mode === 'register' ? registerForm() : loginForm()}

          <div class="auth-toggle">
            ${mode === 'login'
              ? 'New to RocChat? <a id="toggle-auth">Create account</a>'
              : 'Already have an account? <a id="toggle-auth">Sign in</a>'
            }
          </div>
        </div>
      </div>
    `;

    // Bind toggle
    container.querySelector('#toggle-auth')?.addEventListener('click', (e) => {
      e.preventDefault();
      mode = mode === 'login' ? 'register' : 'login';
      render();
    });

    // Bind submit
    container.querySelector('#auth-form')?.addEventListener('submit', (e) => {
      e.preventDefault();
      if (mode === 'login') handleLogin();
      else handleRegister();
    });

    if (mode === 'register') loadTurnstile();
  }

  function loginForm(): string {
    return `
      <form id="auth-form">
        <div class="form-group">
          <label class="form-label" for="username">Username</label>
          <input class="form-input" id="username" name="username" autocomplete="username"
                 placeholder="@noor" required minlength="3" maxlength="24" />
        </div>
        <div class="form-group">
          <label class="form-label" for="passphrase">Passphrase</label>
          <input class="form-input" id="passphrase" name="passphrase" type="password"
                 autocomplete="current-password" placeholder="Your secure passphrase" required />
        </div>
        <button class="btn-primary" type="submit" id="submit-btn">Sign In</button>
      </form>
    `;
  }

  function registerForm(): string {
    return `
      <form id="auth-form">
        <div class="form-group">
          <label class="form-label" for="username">Username</label>
          <input class="form-input" id="username" name="username" autocomplete="username"
                 placeholder="@noor" required minlength="3" maxlength="24"
                 pattern="^[a-zA-Z][a-zA-Z0-9_]{2,23}$" />
          <div class="form-hint">Letters, numbers, underscores. 3-24 characters.</div>
        </div>
        <div class="form-group">
          <label class="form-label" for="display_name">Display Name</label>
          <input class="form-input" id="display_name" name="display_name"
                 placeholder="Noor A." required maxlength="50" />
        </div>
        <div class="form-group">
          <label class="form-label" for="passphrase">Passphrase</label>
          <input class="form-input" id="passphrase" name="passphrase" type="password"
                 autocomplete="new-password" placeholder="Min 4 words or 16 characters" required minlength="16" />
          <div class="form-hint">Use a strong passphrase. This is your ONLY way to log in — no recovery via email or phone.</div>
        </div>
        <div class="form-group">
          <label class="form-label" for="passphrase_confirm">Confirm Passphrase</label>
          <input class="form-input" id="passphrase_confirm" name="passphrase_confirm" type="password"
                 autocomplete="new-password" placeholder="Repeat your passphrase" required />
        </div>
        <div id="turnstile-container"></div>
        <button class="btn-primary" type="submit" id="submit-btn">Create Account</button>
      </form>
    `;
  }

  async function loadTurnstile() {
    const el = document.getElementById('turnstile-container');
    if (!el) return;
    try {
      const res = await api.health();
      const cfg = await fetch('/api/config').then(r => r.json()) as { turnstile_site_key?: string };
      const siteKey = cfg.turnstile_site_key || '1x00000000000000000000AA';
      el.className = 'cf-turnstile';
      el.setAttribute('data-sitekey', siteKey);
      el.setAttribute('data-callback', 'onTurnstileSuccess');
      el.setAttribute('data-theme', 'dark');
      if (typeof (window as any).turnstile !== 'undefined') {
        (window as any).turnstile.render(el);
      }
    } catch { /* fallback: test key already in place */ }
  }

  function showError(msg: string) {
    const el = container.querySelector('#auth-error') as HTMLElement;
    if (el) {
      el.textContent = msg;
      el.classList.remove('hidden');
    }
  }

  function setLoading(loading: boolean) {
    const btn = container.querySelector('#submit-btn') as HTMLButtonElement;
    if (btn) {
      btn.disabled = loading;
      btn.textContent = loading ? 'Processing...' : (mode === 'login' ? 'Sign In' : 'Create Account');
    }
  }

  async function handleLogin() {
    const username = (container.querySelector('#username') as HTMLInputElement).value.trim().toLowerCase().replace(/^@/, '');
    const passphrase = (container.querySelector('#passphrase') as HTMLInputElement).value;

    if (!username || !passphrase) return showError('All fields are required.');

    setLoading(true);
    try {
      // First, derive auth hash with a deterministic salt (username-based for login)
      const salt = new TextEncoder().encode(`rocchat:${username}`);
      const authHash = await deriveAuthHash(passphrase, salt);

      const res = await api.login({ username, auth_hash: toBase64(authHash) });

      if (!res.ok) {
        showError('Invalid username or passphrase.');
        return;
      }

      api.setToken(res.data.session_token);
      localStorage.setItem('rocchat_user_id', res.data.user_id);

      // Decrypt keys with vault key
      const vaultKey = await deriveVaultKey(passphrase, salt);
      if (res.data.encrypted_keys) {
        try {
          const keys = await decryptPrivateKeys(vaultKey, res.data.encrypted_keys);
          localStorage.setItem('rocchat_keys', res.data.encrypted_keys);
          localStorage.setItem('rocchat_identity_pub', res.data.identity_key);

          // Store SPK public from server response for X3DH responder
          if (res.data.signed_pre_key_public) {
            localStorage.setItem('rocchat_spk_pub', res.data.signed_pre_key_public);
          }

          // Cache key material for X3DH responder
          setKeyMaterial({
            signedPreKeyPrivate: keys.signedPreKeyPrivateKey,
            signedPreKeyPublic: res.data.signed_pre_key_public
              ? fromBase64(res.data.signed_pre_key_public)
              : undefined,
            oneTimePreKeys: keys.oneTimePreKeys.map(k => ({
              id: k.id,
              privateKey: k.privateKey,
            })),
          });
        } catch {
          showError('Key decryption failed. Check your passphrase.');
          return;
        }
      }

      onSuccess();
    } catch (err) {
      showError('Connection error. Please try again.');
    } finally {
      setLoading(false);
    }
  }

  async function handleRegister() {
    const username = (container.querySelector('#username') as HTMLInputElement).value.trim().toLowerCase().replace(/^@/, '');
    const displayName = (container.querySelector('#display_name') as HTMLInputElement).value.trim();
    const passphrase = (container.querySelector('#passphrase') as HTMLInputElement).value;
    const passphraseConfirm = (container.querySelector('#passphrase_confirm') as HTMLInputElement).value;

    if (!username || !displayName || !passphrase) return showError('All fields are required.');
    if (passphrase !== passphraseConfirm) return showError('Passphrases do not match.');
    if (passphrase.length < 16) return showError('Passphrase must be at least 16 characters.');

    setLoading(true);
    try {
      const salt = generateSalt();
      const authSalt = new TextEncoder().encode(`rocchat:${username}`);
      const authHash = await deriveAuthHash(passphrase, authSalt);
      const vaultKey = await deriveVaultKey(passphrase, authSalt);

      // Generate crypto keys
      const bundle = await generateKeyBundle();
      const encryptedKeys = await encryptPrivateKeys(vaultKey, bundle);

      // Generate identity DH key for X3DH
      const identityDHKeyPair = await generateX25519KeyPair();

      const res = await api.register({
        username,
        display_name: displayName,
        auth_hash: toBase64(authHash),
        salt: toBase64(salt),
        identity_key: toBase64(bundle.identityKeyPair.publicKey),
        identity_dh_key: toBase64(identityDHKeyPair.publicKey),
        identity_private_encrypted: encryptedKeys,
        signed_pre_key_public: toBase64(bundle.signedPreKey.keyPair.publicKey),
        signed_pre_key_private_encrypted: toBase64(bundle.signedPreKey.keyPair.privateKey),
        signed_pre_key_signature: toBase64(bundle.signedPreKey.signature),
        one_time_pre_keys: bundle.oneTimePreKeys.map((k) => toBase64(k.keyPair.publicKey)),
        turnstile_token: (window as any).__turnstileToken || ''
      });

      if (!res.ok) {
        const data = res.data as { error?: string };
        showError(data?.error || 'Registration failed.');
        return;
      }

      // Store keys locally
      await storeKeysLocally(vaultKey, bundle);

      // Cache identity DH key pair
      localStorage.setItem(
        'rocchat_identity_dh',
        JSON.stringify({ pub: toBase64(identityDHKeyPair.publicKey), priv: toBase64(identityDHKeyPair.privateKey) }),
      );

      // Cache SPK pub for X3DH responder
      localStorage.setItem('rocchat_spk_pub', toBase64(bundle.signedPreKey.keyPair.publicKey));

      // Cache key material for X3DH responder (signed pre-key + OTP keys)
      setKeyMaterial({
        signedPreKeyPrivate: bundle.signedPreKey.keyPair.privateKey,
        signedPreKeyPublic: bundle.signedPreKey.keyPair.publicKey,
        oneTimePreKeys: bundle.oneTimePreKeys.map(k => ({
          id: k.id,
          privateKey: k.keyPair.privateKey,
          publicKey: k.keyPair.publicKey,
        })),
      });

      // Store session
      const resData = res.data as { session_token?: string; user_id?: string };
      if (resData.session_token) {
        api.setToken(resData.session_token);
        localStorage.setItem('rocchat_user_id', resData.user_id || '');
      }

      // Generate and display recovery phrase
      const { mnemonic } = await generateRecoveryPhrase();

      // Store encrypted mnemonic for future recovery verification
      const { aesGcmEncrypt } = await import('@rocchat/shared');
      const { ciphertext, iv, tag } = await aesGcmEncrypt(
        new TextEncoder().encode(mnemonic), vaultKey
      );
      // Concatenate iv(12) + ciphertext + tag(16) for storage
      const packed = new Uint8Array(iv.length + ciphertext.length + tag.length);
      packed.set(iv, 0);
      packed.set(ciphertext, iv.length);
      packed.set(tag, iv.length + ciphertext.length);
      localStorage.setItem('rocchat_recovery_enc', toBase64(packed));

      showRecoveryPhrase(mnemonic, () => {
        mode = 'login';
        render();
        const successEl = container.querySelector('#auth-error') as HTMLElement;
        if (successEl) {
          successEl.textContent = 'Account created! Sign in with your passphrase.';
          successEl.classList.remove('hidden');
          successEl.style.color = 'var(--success)';
          successEl.style.background = 'rgba(30, 166, 114, 0.1)';
          successEl.style.borderColor = 'rgba(30, 166, 114, 0.2)';
        }
      });
    } catch (err) {
      showError('Connection error. Please try again.');
    } finally {
      setLoading(false);
    }
  }

  function showRecoveryPhrase(mnemonic: string, onContinue: () => void) {
    const words = mnemonic.split(' ');
    container.innerHTML = `
      <div class="auth-screen">
        <div class="auth-card recovery-card">
          <div class="auth-logo">
            <img src="/favicon.svg" width="48" height="48" alt="RocChat" />
            <h1>Recovery Phrase</h1>
          </div>
          <div class="recovery-warning">
            <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3Z"/><path d="M12 9v4"/><path d="M12 17h.01"/></svg>
            <p>Write these 12 words down and store them in a safe place. This is your <strong>only way</strong> to recover your account if you lose access.</p>
          </div>
          <div class="recovery-grid">
            ${words.map((w, i) => `<div class="recovery-word"><span class="word-num">${i + 1}</span>${w}</div>`).join('')}
          </div>
          <label class="recovery-confirm-label">
            <input type="checkbox" id="recovery-ack" />
            I have written down my recovery phrase
          </label>
          <button class="btn-primary" id="recovery-continue" disabled>Continue</button>
        </div>
      </div>
    `;
    const ack = container.querySelector('#recovery-ack') as HTMLInputElement;
    const btn = container.querySelector('#recovery-continue') as HTMLButtonElement;
    ack.addEventListener('change', () => { btn.disabled = !ack.checked; });
    btn.addEventListener('click', onContinue);
  }

  render();
}
