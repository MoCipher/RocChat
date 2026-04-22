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
| **D**oS                 | Per-user/route token-bucket rate limits in KV; PoW gate for registration; 10 MB global payload guard; 64 KB encrypted-message ceiling; WS send rate limit (30 msg/s) |
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
  Permissions-Policy denylist, and enforced `Trusted Types`
  (`require-trusted-types-for 'script'`) with a restrictive default policy.
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

## Recent UI/UX security-relevant changes

- **Splash screen (all platforms)**: Loading screen is now a fixed overlay with
  minimum 800 ms display and a fade-out transition. Prevents UI content from
  briefly flashing before authentication/app-lock checks complete.
- **App icon**: Replaced speech bubble with signal wave arcs; background changed
  from cold blue-black to warm charcoal. No security impact; branding only.
- **Settings redesign (web)**: Card-based sections, hover states, removed inline
  emoji in favour of inline SVGs. No change to encryption controls or auth flows.
- **Donor badges**: Replaced emoji-based badges with custom SVG feather paths.
  No change to authentication or payment flows.
- **iOS splash**: New SwiftUI `SplashView` as a ZStack overlay in `RocChatApp`.
  Dismissed after 0.8 s. Does not affect biometric lock or auth flow ordering.
- **Android splash**: `RocSplashScreen` composable in `MainActivity`. Uses
  `AnimatedVisibility` overlay dismissed after 800 ms via `LaunchedEffect`.
  Auth checks and biometric lock are unchanged.
- **Landing page overhaul**: Glassmorphism sticky nav, hero radial glow, beta
  badge pill, manifesto quote section, 8 feature cards with scroll-in animations,
  mobile hamburger menu, enhanced footer. No auth endpoints or data flows changed.
  All links are static (`#` anchors, mailto, GitHub). No third-party scripts added.
- **Emoji removal (settings)**: Replaced all remaining emoji in settings labels,
  org admin buttons, empty states, device icons, and manifesto section with inline
  SVGs or clean text. No functional changes to any controls or flows.
- **Blank page fix**: Moved `#loading-screen` from inside `#app` to a sibling
  element so `replaceChildren()` cannot destroy it before `dismissSplash()` runs.
  Wrapped `init()` in try-catch so splash is always dismissed on error, with
  fallback to landing page. Bumped SW cache to `rocchat-v10` to force refresh.
- **CSP / Trusted Types overhaul**: Renamed TT policy to `'default'` so the
  browser auto-applies `createHTML`/`createScriptURL` at all injection sinks.
  Removed all inline event handlers (`onclick`, `onerror`) and replaced with
  `addEventListener` / `data-fallback` attributes + global delegated listener.
  Added separate `sw-init` TT policy for the service worker registration URL sink.
  Removed stale script hashes from `_headers`; synced meta CSP with server CSP.
  Added `data:` to `font-src` for `@fontsource` base64 fonts. Removed unsupported
  `frame-ancestors` from meta tag (only valid as HTTP header).
- **COEP header**: Added `Cross-Origin-Embedder-Policy: credentialless` for
  cross-origin isolation, enabling `SharedArrayBuffer` for future crypto/WebRTC
  performance improvements.
- **WebSocket auth fix**: Router now validates WS tickets and passes
  `routerAuthed=1` to the Durable Object, preventing 400 errors when ticket-based
  connections lacked a `token` query param.
- **Rate limiting**: Added dedicated rate limit bucket for `/api/ws/ticket`
  (30 req/min) to prevent ticket flooding.
- **Offline page**: Replaced inline `onclick` with `addEventListener` and added
  a CSP meta tag with script hash. Replaced emoji with SVG wifi-off icon.
- **PWA badge count**: Added `navigator.setAppBadge()` support to show unread
  conversation count on the home screen icon.
- **Build optimizations**: Vite now targets ES2022 for smaller output, produces
  hidden source maps, and splits crypto code into a separate cached chunk.
- **Preconnect hints**: Added `<link rel="preconnect">` and `dns-prefetch` for
  the API domain to reduce first-request latency.

---
_Last updated: 2026-04-22_
