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

- The server is **honest-but-curious**. It can read routing metadata
  (timestamps, conversation IDs, encrypted blob sizes) but it cannot read
  message content, display names, profile fields, avatars, group names,
  contact nicknames, file metadata, call signaling data, typing indicators,
  read receipts, or any other user content — all encrypted client-side
  with vault-derived or ratchet-derived keys.
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
  pre-keys + one-time pre-keys. Sender Keys for group chats.
- Symmetric: AES-256-GCM for messages, media, profile data, avatars, group
  metadata, contact nicknames, file metadata, and at-rest secrets.
- KDF: HKDF-SHA256 for ratchet, vault sub-key derivation, and metadata signal
  keys. Argon2id or PBKDF2-SHA256 (passphrase → auth hash / vault key).
- Vault key: passphrase-derived root of trust for all non-message encryption.
  Sub-keys derived via HKDF with domain-specific info strings
  (`rocchat:profile:encrypt`, `rocchat:avatar:encrypt`,
  `rocchat:meta:{conversationId}`).
- Pre-key replenishment: client refills when remaining count < 5.
- Key rotation: signed pre-keys rotate on schedule; ratchet auto-rotates per
  message; sender keys rotate when a group member leaves.

## Network hardening

- TLS pinning on iOS (`PinnedSessionDelegate`) and Android (network security
  config + code-side fingerprint check).
- WebSocket connections use short-lived tickets (not session tokens) in URL
  query strings across all platforms, preventing token logging via URLs.
- Web headers: HSTS preload, COOP, COEP-ready, strict CSP, full
  Permissions-Policy denylist, and enforced `Trusted Types`
  (`require-trusted-types-for 'script'`) with a restrictive default policy.
- CORS: explicit allowlist (`chat.mocipher.com`, `rocchat-8x7.pages.dev`,
  `localhost:5173`); unknown Origins receive **no** `Access-Control-Allow-Origin`.
- Origin-bound CSRF: state-changing routes require an allowed `Origin` header.

## At-rest secret storage

| Platform | Wrapping                                            | Notes                                |
| -------- | --------------------------------------------------- | ------------------------------------ |
| iOS      | AES-256-GCM with master key in Keychain (`AfterFirstUnlockThisDeviceOnly`) | UserDefaults blob is encrypted; vault key stored in Keychain |
| Android  | EncryptedSharedPreferences + Keystore (StrongBox where available) | Key alias rotated on tamper; vault key in EncryptedSharedPreferences |
| Web      | AES-256-GCM with non-extractable CryptoKey in IDB   | Wraps identity priv, vault key, drafts, tokens  |

The **vault key** (passphrase-derived via PBKDF2/Argon2id) is the root secret
for all non-message encryption. It is stored at login/registration and used to
derive sub-keys via HKDF for profile, avatar, group metadata, contact nickname,
and metadata signal encryption.

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
- iOS Notification Service Extension with App Group keychain for E2E quick-reply
  from the lock screen (currently disabled to prevent plaintext bypass).

## E2E encryption hardening (April 2026)

The following changes eliminate all identified plaintext leaks and metadata
exposure across all platforms (Web, iOS, Android):

### Push notification privacy
- Push body changed from `"New message from {senderName}"` to generic
  `"New message"`. Sender identity no longer leaked to APNs / ntfy / Web Push
  providers.
- iOS lock-screen quick-reply (`REPLY_ACTION`) removed — it bypassed E2E by
  sending plaintext to the server. Replaced with `OPEN_CHAT_ACTION` that opens
  the app for full Double Ratchet encrypted replies.

### Profile & metadata encryption (vault-derived keys)
- Profile fields (`display_name`, `status_text`) now encrypted with
  `HKDF(vaultKey, "rocchat:profile:encrypt")` → AES-256-GCM on all platforms.
  Legacy identity-pub-derived key supported for backward-compatible decryption.
- `display_name` encrypted at registration time (Web, iOS, Android) so the
  server never sees the plaintext display name, even at first signup.
- Avatars encrypted client-side with
  `HKDF(vaultKey, "rocchat:avatar:encrypt")` → AES-256-GCM before upload.
  Backend accepts `application/octet-stream` content type for encrypted blobs.
  Web client transparently decrypts via `installAvatarFallback()`.
- Group names sent as `encrypted_meta` (not plaintext `name`) on all platforms,
  encrypted with the vault-derived profile key.
- Contact nicknames encrypted with vault-derived profile key before server
  storage.

### Message encryption completeness
- Web: removed `members.length > 2` condition — all group messages now use
  Sender Keys, including 2-member groups.
- Web: plaintext fallback branch replaced with error throw — messages cannot
  be sent without an encryption session.
- iOS / Android: `GroupSessionManager` wired into main chat UI for both message
  send and message edit. No plaintext fallback path exists.
- Message edits re-encrypted via Double Ratchet (1:1) or Sender Keys (group)
  on all platforms. Backend stores the encrypted JSON envelope, not raw text.

### Media metadata encryption
- File upload headers (`x-encrypted-filename`, `x-encrypted-mimetype`) now
  contain AES-256-GCM ciphertext instead of plaintext filenames and MIME types.
  R2 custom metadata stores only ciphertext.

### Metadata signal keys (typing, receipts, presence)
- Per-conversation metadata encryption key changed from
  `SHA-256(identityPub + conversationId)` (weak — identity pub is public) to
  `HKDF(vaultKey, "rocchat:meta:{conversationId}")`. Legacy key supported for
  backward-compatible decryption.

### Call signaling
- Plaintext fallback in `encryptGroupSignaling()` removed. If encryption fails,
  the call signal is dropped rather than sent in cleartext.
- 1:1 `encryptSignaling()` throws if no conversation is established.

### Link preview privacy
- Web client now supports three link preview modes: **Server** (default — server
  proxies fetch, user IP hidden from target), **Client-side** (direct fetch,
  URLs hidden from server), and **Disabled**. Configurable in Settings → Privacy.

### Vault key lifecycle
- Vault key persisted to secure storage on login and registration across all
  platforms (IndexedDB on Web, Keychain on iOS, EncryptedSharedPreferences on
  Android) so profile/avatar/metadata encryption functions can access it in
  subsequent sessions.

## E2E encryption hardening — round 2 (April 2026)

Additional plaintext leaks and cross-platform inconsistencies eliminated:

### Message forwarding (web)
- Forward-to-group now uses Sender Keys encryption instead of sending plaintext
  in the `ciphertext` field. Forwarding to a conversation without an encryption
  session throws an error.

### Chat import (web)
- Imported messages (WhatsApp / Telegram / Signal) are now E2E-encrypted
  client-side with `encryptProfileField()` before POSTing to the backend.
  Both `body` and `sender_name` fields are encrypted. The server stores only
  ciphertext in `messages.encrypted`.

### File/media sends (iOS, Android)
- Group file/photo uploads now use GroupSessionManager instead of sending the
  file-key JSON as plaintext when `recipientId` is empty. Both platforms throw
  an error if no encryption path is available.
- iOS `MediaManager` now sends required `x-conversation-id`,
  `x-encrypted-filename`, and `x-encrypted-mimetype` headers, all encrypted
  with the vault-derived profile key.
- Android `MediaManager` / `APIClient` file upload headers now encrypted with
  vault-derived profile key (matching web behavior).

### Call signaling (iOS, Android)
- iOS `CallManager` no longer falls back to plaintext on encrypt failure —
  the signal is dropped and an error is logged.
- Android `CallManager` same fix — encrypt failures do not fall through to
  cleartext send.
- Decrypt-side fallback on all platforms preserved for backward compatibility
  with older clients that may still send unencrypted signals.

### Metadata signal keys (iOS, Android)
- iOS and Android `getMetaKey` / `getMetaKeyBytes` now derive per-conversation
  keys from `HKDF(vaultKey, "rocchat:meta:{conversationId}")` when the vault
  key is available, matching the web implementation. Legacy SHA-256 derivation
  from the identity public key is preserved for backward compatibility.

### Typing / read receipt fallbacks (web)
- Unencrypted `isTyping` and `messageIds` WebSocket payloads are now silently
  dropped instead of being honored. Only payloads with encrypted `e` field are
  processed.

### Link previews (iOS, Android)
- Both platforms now support three link preview modes: **Server** (default),
  **Client-side** (private — direct fetch, URLs hidden from server), and
  **Disabled**. Configurable via a new Picker/dropdown in Privacy settings.

### Channel posts (iOS, Android)
- Legacy base64-plaintext fallback for channel posts removed. If the channel
  encryption key is not available, the post is refused with an error message
  instead of silently sending plaintext.

### Push notifications (Android)
- Android `PushManager.showMessageNotification` now displays generic
  "New message" instead of attempting to parse sender name from the push body.

### Presence (known limitation)
- Online/offline presence is broadcast server-side by the Durable Object with
  the user's ID in cleartext. This is an architectural requirement for real-time
  routing and is documented as an acceptable trade-off — the server already
  knows conversation membership from routing. User IDs are opaque UUIDs.

## E2E encryption hardening — round 3 (April 2026)

### WebSocket authentication (iOS, Android)
- iOS and Android now use a short-lived WS ticket (fetched via `POST /api/ws/ticket`)
  instead of embedding the long-lived session token in the WebSocket URL query
  string. This prevents token exposure via URL logs, caches, and referer headers.
  Matches the existing web implementation.

### Delivery receipt encryption (iOS)
- iOS now encrypts `delivery_receipt` message IDs using the per-conversation
  `encryptMeta` function, matching Android's existing encrypted receipt format.
  Previously sent `message_id` in cleartext.

### Message forwarding (iOS)
- `forwardMessageTo` now re-encrypts the message for the target conversation
  using SessionManager (1:1) or GroupSessionManager (groups) instead of sending
  raw ciphertext with empty encryption fields.

### Fail-closed decryption (all platforms)
- iOS `SessionManager.decryptMessage` no longer returns raw ciphertext on parse
  failures — returns `"[Unable to decrypt]"` placeholder instead of passing
  through potentially sensitive data.
- iOS chat UI shows `"[Unable to decrypt]"` when decryption fails, instead of
  displaying raw ciphertext blobs.
- Android same treatment — decrypt catch blocks now show placeholder.
- Web `profile-crypto.ts` `aesDecrypt` returns `"[encrypted]"` on failure
  instead of the raw encrypted payload.

### Channel posts (web)
- Legacy base64-plaintext channel post display path removed. Posts without
  valid E2E encryption metadata now show `"[Encrypted post — key not yet
  received]"` instead of attempting base64 decode.

### Presence (documented limitation)
- Online/offline presence is broadcast server-side with user UUID. This is
  an inherent architectural requirement for real-time routing. UUIDs are opaque
  and do not contain PII.

## E2E encryption hardening — round 4 (April 2026)

### Channel post plaintext fallback removed (web)
- Web channel composer now refuses to post if no E2E channel key is available,
  instead of falling back to base64-encoded plaintext. iOS/Android already had
  this enforcement; web was the last platform with a legacy path.

### GIF send plaintext fallback removed (web)
- GIF sending in group conversations now always uses Sender Keys (`groupEncrypt`)
  regardless of member count. The previous code only used group encryption for
  groups with >2 members and sent plaintext for 2-member groups. A missing
  encryption session now shows an error instead of sending unencrypted.

### Data export encryption mandatory (web)
- The "Export My Data" feature no longer offers an unencrypted download option.
  Users must provide a passphrase (12+ characters) which is stretched via
  PBKDF2-SHA256 (600k iterations) to derive an AES-256-GCM export key.

### Reaction encryption (all platforms)
- iOS and Android reaction SEND already used `encryptProfileField`; the WS
  RECEIVE handler on both platforms now reads the `encrypted_reaction` field
  (not the legacy `emoji` field) and decrypts via `decryptProfileField`.
- Web reaction receive handler now decrypts remote reactions with
  `decryptProfileField`, replacing the generic `✨` placeholder.

### Unencrypted metadata signal payloads dropped (iOS, Android)
- iOS and Android WS handlers for `presence` no longer process unencrypted
  fallback payloads (`fromUserId` + `status`). Only encrypted `e`-field
  payloads are accepted, matching the existing web policy.
- Typing and delivery/read receipt handlers were already encrypted-only on
  both platforms; the presence handler was the last unencrypted fallback.

### Message edit WS decryption (web)
- The web `message_edit` WS handler now properly decrypts edited messages
  (both group via `groupDecrypt` and 1:1 via `decryptMessage`) instead of
  storing the raw encrypted JSON string for display.

### Android message forwarding (already fixed)
- Android `forwardMessageTo` was verified to re-encrypt the decrypted message
  text for the target conversation using `SessionManager` (1:1) or
  `GroupSessionManager` (groups), matching iOS and web behavior.

### Group message decryption (iOS, Android — already fixed)
- iOS and Android REST loading, WS inbound, and WS edit handlers all use
  `GroupSessionManager.isGroupEncrypted()` to detect Sender Key envelopes
  and route to `GroupSessionManager.decrypt()`, matching the web's
  `isGroupEncrypted` / `groupDecrypt` flow.

## UI/UX hardening (April 2026)

### Accessibility fixes (web)
- Removed `maximum-scale=1.0` viewport restriction — low-vision users can now
  pinch-zoom up to 5x on mobile web. Updated to `maximum-scale=5.0`.
- Fixed duplicate `role` attribute on sidebar nav (`role="navigation"` +
  `role="tablist"` — the second silently overrode the first).
- Toast notifications now carry per-toast `role` and `aria-live` attributes
  (`assertive` for errors, `polite` for info/success) instead of a single
  container-level `role="alert"`.
- Resolved `⌘K` / `Ctrl+K` keyboard conflict — palette and global search no
  longer both open; the command palette is the single owner and includes a
  "Search conversations & messages" command.

### CSS hygiene (web)
- Deduplicated `.typing-indicator` (3 definitions → 1 canonical), `.conversation-item.active`
  (double highlight → single inset bar), `html` font-size (conflicting scale vs
  fixed 16px → single scale), `.skip-link` (2 → 1), and `prefers-reduced-motion`
  (2 → 1). Removed dead `.msg-status` rules (chat uses `.message-status`).
- Merged duplicate `.sr-only` / `.visually-hidden` utilities into one block.

### Message grouping (all platforms)
- Consecutive messages from the same sender within 2 minutes are now visually
  grouped: tighter spacing, connected bubble corners, and timestamps shown
  only on the last message in each group.
- Date separator chips ("Today", "Yesterday", weekday, or date) inserted
  between messages from different calendar days on all platforms.

### Chat bubble theming (iOS)
- `ChatThemeOption` bubble colors (`bubbleMine` / `bubbleTheirs`) are now wired
  into `MessageBubbleView`. Previously, changing the chat theme only changed the
  wallpaper background.

### Dynamic Type (iOS)
- Fixed font sizes in chat bubbles, timestamps, and sender names replaced with
  text styles (`.body`, `.caption2`, `.headline`) for proper Dynamic Type scaling.

### Compose best practices (Android)
- Added stable `key` parameters to all `LazyColumn` `items()` calls (messages,
  calls, channels) to prevent wrong-item reuse and animation glitches.
- Added `imePadding()` to conversation Scaffold for proper keyboard insets.
- Replaced hardcoded `sp` font sizes with `MaterialTheme.typography` tokens.
- Replaced `RocColors.TextPrimary/TextSecondary` with `MaterialTheme.colorScheme`
  semantic colors for dark/light theme consistency.
- Added animated typing indicator (bouncing dots) replacing static "typing •••".
- Changed Chats tab icon from `Email` to `Chat`.
- Added `SnackbarHostState` for recoverable error feedback.
- Added link preview loading placeholder (shimmer skeleton).

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

### iOS inbox WebSocket fix (call delivery)
- Fixed critical bug where `InboxWebSocket.swift` read `UserDefaults` key
  `rocchat_user_id` while auth stored the user ID under `user_id`. The mismatch
  caused `connect()` to bail out immediately, so the per-user inbox WebSocket
  was **never established** on iOS. This meant `call_offer`, `call_answer`, and
  all other call signaling forwarded via the `UserInbox` Durable Object were
  silently dropped — the caller saw "Calling…" indefinitely while the callee
  received nothing. Key aligned to `user_id` to match `AuthViewModel`.

### iOS WebSocket origin alignment (call reliability)
- Removed hardcoded iOS WebSocket host usage and now derive WS endpoints from
  the same configured API base URL (`APIClient.baseURL`) for both inbox WS and
  conversation WS. This prevents split-origin failures where `/ws/ticket` is
  issued by one host but the socket tries to connect to another host.
- Added a one-time inbox listener registration guard in `RocChatApp.swift` so
  incoming `call_offer` events are handled exactly once per app session. This
  avoids duplicate handlers racing and incorrectly rejecting calls as "busy."

### Signaling format interoperability hardening (web <-> iOS)
- Web call signaling now serializes Double Ratchet headers into
  `ratchet_header` string format expected by native clients.
- Web decrypt path now accepts both serialized-string and object header forms,
  allowing robust decryption of iOS-originated `encryptedSignaling` payloads.
- Fixed ICE server auth token lookup on web calls to use the active
  session-scoped token source, preventing unauthenticated ICE fetch failures.
- Web and iOS call WebSocket endpoints use the dedicated Worker WS host
  (`rocchat-api.spoass.workers.dev`) for conversation and inbox signaling.
  This avoids relying on front-end proxy paths that may not support WebSocket
  upgrade semantics in all environments.

### Business feature removal
- Removed Business-tier backend/API entrypoints and client surfaces from active
  app code. No `/api/business/*` routes remain in runtime code paths.
- Historical migration files still contain `business` strings by design (schema
  history), and BIP39 wordlists still contain the standard mnemonic word
  `"business"` (cryptographic compatibility requirement).

---
_Last updated: 2026-04-27_
