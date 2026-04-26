/**
 * RocChat Web — Auth UI
 *
 * Login and registration screens. Zero-knowledge: passphrase never leaves device.
 */

import * as api from '../api.js';
import { parseHTML } from '../utils.js';
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
import { putSecretString } from '../crypto/secure-store.js';

export function renderAuth(container: HTMLElement, onSuccess: () => void) {
  let mode: 'login' | 'register' = 'login';

  function render() {
    container.replaceChildren(parseHTML(`
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
    `));

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

    if (mode === 'register') initPowWidget();
  }

  function loginForm(): string {
    return `
      <form id="auth-form">
        <div class="form-group">
          <label class="form-label" for="username">Username</label>
          <input class="form-input" id="username" name="username" autocomplete="username"
                 placeholder="@noor" required minlength="3" maxlength="24" autocapitalize="off"
                 aria-required="true" />
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
                 placeholder="@noor" required minlength="3" maxlength="24" autocapitalize="off"
                 pattern="^[a-zA-Z][a-zA-Z0-9_]{2,23}$" aria-required="true" aria-describedby="username-hint" />
          <div class="form-hint" id="username-hint">Letters, numbers, underscores. 3-24 characters.</div>
        </div>
        <div class="form-group">
          <label class="form-label" for="display_name">Display Name</label>
          <input class="form-input" id="display_name" name="display_name"
                 placeholder="Noor A." required maxlength="50" />
        </div>
        <div class="form-group">
          <label class="form-label" for="passphrase">Passphrase</label>
          <input class="form-input" id="passphrase" name="passphrase" type="password"
                 autocomplete="new-password" placeholder="Min 4 words or 16 characters" required minlength="16"
                 aria-required="true" aria-describedby="passphrase-hint" />
          <div class="form-hint" id="passphrase-hint">Use a strong passphrase. This is your ONLY way to log in — no recovery via email or phone.</div>
        </div>
        <div class="form-group">
          <label class="form-label" for="passphrase_confirm">Confirm Passphrase</label>
          <input class="form-input" id="passphrase_confirm" name="passphrase_confirm" type="password"
                 autocomplete="new-password" placeholder="Repeat your passphrase" required />
        </div>
        <div id="pow-status" style="font-size:var(--text-xs);color:var(--text-tertiary);margin-bottom:var(--sp-2)"></div>
        <button class="btn-primary" type="submit" id="submit-btn">Create Account</button>
      </form>
    `;
  }

  async function initPowWidget() {
    const el = document.getElementById('pow-status');
    if (el) el.textContent = '\uD83D\uDD12 Proof-of-work protection active \u2014 no third-party CAPTCHA';
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

  async function solvePowIfAvailable(): Promise<{ token?: string; nonce?: string }> {
    try {
      const challengeRes = await api.getPowChallenge();
      if (!challengeRes.ok) return {};
      const { token, challenge, difficulty } = challengeRes.data;
      const nonce = await solvePow(challenge, difficulty);
      return { token, nonce };
    } catch {
      return {};
    }
  }

  async function solvePow(challenge: string, difficulty: number): Promise<string> {
    const enc = new TextEncoder();
    let nonce = 0;
    while (nonce < 10_000_000) {
      const digest = await crypto.subtle.digest('SHA-256', enc.encode(`${challenge}:${nonce}`));
      const bytes = new Uint8Array(digest);
      if (leadingZeroBits(bytes) >= difficulty) return String(nonce);
      nonce++;
      if (nonce % 1000 === 0) {
        await new Promise<void>((resolve) => setTimeout(resolve, 0));
      }
    }
    throw new Error('PoW solve timeout');
  }

  function leadingZeroBits(bytes: Uint8Array): number {
    let bits = 0;
    for (const b of bytes) {
      if (b === 0) {
        bits += 8;
        continue;
      }
      if ((b & 0b10000000) === 0) bits += 1; else return bits;
      if ((b & 0b01000000) === 0) bits += 1; else return bits;
      if ((b & 0b00100000) === 0) bits += 1; else return bits;
      if ((b & 0b00010000) === 0) bits += 1; else return bits;
      if ((b & 0b00001000) === 0) bits += 1; else return bits;
      if ((b & 0b00000100) === 0) bits += 1; else return bits;
      if ((b & 0b00000010) === 0) bits += 1; else return bits;
      if ((b & 0b00000001) === 0) bits += 1; else return bits;
    }
    return bits;
  }

  async function handleLogin() {
    const username = (container.querySelector('#username') as HTMLInputElement).value.trim().toLowerCase().replace(/^@/, '');
    const passphrase = (container.querySelector('#passphrase') as HTMLInputElement).value;

    if (!username || !passphrase) return showError('All fields are required.');

    setLoading(true);
    try {
      const pow = await solvePowIfAvailable();
      // First, derive auth hash with a deterministic salt (username-based for login)
      const salt = new TextEncoder().encode(`rocchat:${username}`);
      const authHash = await deriveAuthHash(passphrase, salt);

      const res = await api.login({
        username,
        auth_hash: toBase64(authHash),
        pow_token: pow.token,
        pow_nonce: pow.nonce,
      });

      if (!res.ok) {
        showError('Invalid username or passphrase.');
        return;
      }

      api.setToken(res.data.session_token);
      if (res.data.refresh_token) api.setRefreshToken(res.data.refresh_token);
      localStorage.setItem('rocchat_user_id', res.data.user_id);
      if (res.data.device_id) localStorage.setItem('rocchat_device_id', res.data.device_id);

      // Decrypt keys with vault key
      const vaultKey = await deriveVaultKey(passphrase, salt);
      if (res.data.encrypted_keys) {
        try {
          const keys = await decryptPrivateKeys(vaultKey, res.data.encrypted_keys);
          await putSecretString('rocchat_keys', res.data.encrypted_keys);
          localStorage.setItem('rocchat_identity_pub', res.data.identity_key);
          await putSecretString('rocchat_identity_priv', toBase64(keys.identityPrivateKey));

          // Store SPK public from server response for X3DH responder
          if (res.data.signed_pre_key_public) {
            localStorage.setItem('rocchat_spk_pub', res.data.signed_pre_key_public);
          }

          // Restore identity DH keypair if present in the encrypted blob.
          // Without this, a fresh device login regenerates a new identity DH
          // key locally, breaking E2E sessions and channel ECIES decryption.
          if (keys.identityDHPrivateKey && keys.identityDHPublicKey) {
            await putSecretString(
              'rocchat_identity_dh',
              JSON.stringify({
                pub: toBase64(keys.identityDHPublicKey),
                priv: toBase64(keys.identityDHPrivateKey),
              }),
            );
          } else {
            // Legacy account migration: the encrypted vault predates multi-device
            // recovery. If we have a local identity DH (we do, because this device
            // was used to register or has been logged in once before this fix),
            // re-encrypt the bundle with that DH key inside and push it to the
            // server. After this runs once, future device logins for this user
            // can fully restore E2E identity from password alone.
            try {
              const { getIdentityDHKeyPair } = await import('../crypto/session-manager.js');
              const dh = await getIdentityDHKeyPair();
              const reEncrypted = await encryptPrivateKeys(
                vaultKey,
                {
                  identityKeyPair: {
                    publicKey: fromBase64(res.data.identity_key),
                    privateKey: keys.identityPrivateKey,
                  },
                  signedPreKey: {
                    id: 0,
                    keyPair: {
                      publicKey: res.data.signed_pre_key_public
                        ? fromBase64(res.data.signed_pre_key_public)
                        : new Uint8Array(),
                      privateKey: keys.signedPreKeyPrivateKey,
                    },
                    signature: new Uint8Array(),
                  },
                  oneTimePreKeys: keys.oneTimePreKeys.map((k) => ({
                    id: k.id,
                    keyPair: { publicKey: new Uint8Array(), privateKey: k.privateKey },
                  })),
                },
                dh,
              );
              await api.updateEncryptedBundle(reEncrypted);
              await putSecretString('rocchat_keys', reEncrypted);
            } catch {
              /* migration is best-effort — failure is non-fatal because the
                 user's local identity DH still works on this device */
            }
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
      const pow = await solvePowIfAvailable();
      const salt = generateSalt();
      const authSalt = new TextEncoder().encode(`rocchat:${username}`);
      const authHash = await deriveAuthHash(passphrase, authSalt);
      const vaultKey = await deriveVaultKey(passphrase, authSalt);

      // Generate crypto keys
      const bundle = await generateKeyBundle();

      // Generate identity DH key for X3DH and channel ECIES wrap.
      // Bundle it into the encrypted vault so a fresh device login restores it.
      const identityDHKeyPair = await generateX25519KeyPair();
      const encryptedKeys = await encryptPrivateKeys(vaultKey, bundle, identityDHKeyPair);

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
        pow_token: pow.token,
        pow_nonce: pow.nonce,
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
      const resData = res.data as { session_token?: string; refresh_token?: string; user_id?: string; device_id?: string };
      if (resData.session_token) {
        api.setToken(resData.session_token);
        if (resData.refresh_token) api.setRefreshToken(resData.refresh_token);
        localStorage.setItem('rocchat_user_id', resData.user_id || '');
        if (resData.device_id) localStorage.setItem('rocchat_device_id', resData.device_id);
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
    container.replaceChildren(parseHTML(`
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
    `));
    const ack = container.querySelector('#recovery-ack') as HTMLInputElement;
    const btn = container.querySelector('#recovery-continue') as HTMLButtonElement;
    ack.addEventListener('change', () => { btn.disabled = !ack.checked; });
    btn.addEventListener('click', onContinue);
  }

  render();
}
