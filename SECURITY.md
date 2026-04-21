# RocChat Security Policy

## Reporting a vulnerability

Please email **security@chat.mocipher.com** with details. We will respond
within 72 hours and aim to patch high-severity issues within 14 days.
For critical key-disclosure or remote-code-execution issues, encrypt your
report with our PGP key (fingerprint published on the warrant canary page).

Do **not** open public GitHub issues for security findings.

## Supported versions

| Component        | Supported version             |
| ---------------- | ----------------------------- |
| Web (Pages)      | latest deployed build only    |
| iOS app          | current TestFlight + App Store |
| Android app      | current Play Internal + Store |
| Backend (Workers)| latest deployed `main`        |

Older clients are blocked at the API once a security-critical version is
released.

## Threat model

RocChat is designed under the following assumptions:

- The server is **honest-but-curious**. It can read all metadata it stores
  (timestamps, conversation membership, encrypted blob sizes) but it
  cannot read message content, profile content, or group metadata that
  has been encrypted client-side.
- The TLS layer is intact. Cert pinning on iOS and Android, and HSTS
  preload + COOP on the web, guard against rogue CAs and mixed-origin
  injection.
- The user controls their device. We do not defend against physical
  capture of an unlocked device — but at-rest secrets (identity key,
  ratchet state, session tokens) are encrypted with a Keychain/Keystore
  master key on mobile and a non-extractable AES-GCM wrap key in
  IndexedDB on the web.
- The recovery phrase is the user's responsibility. Loss of phrase + loss
  of all linked devices = permanent message loss; we cannot recover keys.

## STRIDE summary

| Threat                  | Mitigation                                                                |
| ----------------------- | ------------------------------------------------------------------------- |
| **S**poofing identity   | X3DH + Ed25519 signed pre-keys; safety-number / QR verification UI        |
| **T**ampering w/ msgs   | AES-256-GCM authenticated encryption; Double Ratchet integrity            |
| **R**epudiation         | Per-device session tokens + audit log on key changes (`key_audit_log`)    |
| **I**nfo disclosure     | E2EE; server stores ciphertext only; encrypted media in R2; encrypted IDB |
| **D**oS                 | Per-user/route token-bucket rate limits in KV; PoW gate for registration  |
| **E**levation of priv.  | RBAC on group/admin endpoints; CSRF via Origin allowlist; bearer + KV    |

## Cryptography summary

- Identity: Ed25519 long-term keys + X25519 DH keys (X3DH initial handshake).
- Sessions: Double Ratchet (Signal-style) per pair, with rotating signed
  pre-keys + one-time pre-keys.
- Symmetric: AES-256-GCM for messages, media, and at-rest secrets.
- KDF: HKDF-SHA256 for ratchet, Argon2id (passphrase) where applicable.
- Pre-key replenishment: client refills when remaining count < 5.
- Key rotation: signed pre-keys rotate on schedule; ratchet auto-rotates per
  message.

## Network hardening

- TLS pinning on iOS (`PinnedSessionDelegate`) and Android (network security
  config + code-side fingerprint check).
- Web headers: HSTS preload, COOP, COEP-ready, strict CSP, full
  Permissions-Policy denylist, `Trusted Types` policy declared (enforcement
  is staged via `Content-Security-Policy-Report-Only`).
- CORS: explicit allowlist (`chat.mocipher.com`, `rocchat-8x7.pages.dev`,
  `localhost:5173`); unknown Origins receive **no** `Access-Control-Allow-Origin`.
- Origin-bound CSRF: state-changing routes require an allowed `Origin` header.

## At-rest secret storage

| Platform | Wrapping                                            | Notes                                |
| -------- | --------------------------------------------------- | ------------------------------------ |
| iOS      | AES-256-GCM with master key in Keychain (`AfterFirstUnlockThisDeviceOnly`) | UserDefaults blob is encrypted       |
| Android  | EncryptedSharedPreferences + Keystore (StrongBox where available) | Key alias rotated on tamper          |
| Web      | AES-256-GCM with non-extractable CryptoKey in IDB   | Wraps identity priv, drafts, tokens  |

## Build & supply chain

- Web is built from this repo by the deploy operator; no third-party CDNs at
  runtime (fonts and icons bundled via npm + `@fontsource`/`lucide`).
- iOS/Android use only first-party or Apache/MIT-licensed libraries; no
  Google Play Services, no Firebase, no analytics SDKs.
- We track upstream CVEs via `npm audit` and Renovate-style monthly review;
  the warrant canary records the most recent dependency audit date.

## Out of scope (planned follow-ups)

- Reproducible iOS/Android builds (deterministic build flags + checksums).
- Public security audit by a third party.
- Hardware-backed identity key on iOS via `SecureEnclave` for newer devices.
- WebAuthn passkey unlock for the web client.

---
_Last updated: 2026-04-21_
