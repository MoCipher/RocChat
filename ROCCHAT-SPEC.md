# RocChat — Complete Product Specification

> **RocChat — Messages. Calls. Nothing else. Everything encrypted. No phone number. No compromise.**

RocChat is part of the **Roc Family** (alongside RocMail and RocPass). It is a secure, private, end-to-end encrypted messaging and calling app built on Cloudflare infrastructure with native iOS and Android clients.

---

## Table of Contents

1. [Tech Stack](#1-tech-stack)
2. [Roc Design System](#2-roc-design-system)
3. [App Icon & Badges](#3-app-icon--badges)
4. [E2E Encryption Architecture](#4-e2e-encryption-architecture)
5. [Authentication System](#5-authentication-system)
6. [Voice & Video Calls](#6-voice--video-calls)
7. [Contact Discovery](#7-contact-discovery)
8. [Privacy Settings](#8-privacy-settings)
9. [Competitive Features](#9-competitive-features)
10. [Pricing Tiers & Donations](#10-pricing-tiers--donations)
11. [Architecture & Infrastructure](#11-architecture--infrastructure)
12. [Project Structure](#12-project-structure)

---

## 1. Tech Stack

### Backend (Cloudflare Workers)

| Layer | Technology | Why |
|---|---|---|
| Language | **TypeScript** | First-class Cloudflare Workers support, shared crypto logic with web client |
| Runtime | Cloudflare Workers | Serverless, edge-deployed, scales to zero |
| Database | **Cloudflare D1** (SQLite) | Stores encrypted message blobs, user metadata, key bundles — sharded by user_id hash for scale |
| Realtime | **Durable Objects + WebSockets** | Persistent WebSocket connections for real-time message delivery and presence |
| File/Media Storage | **Cloudflare R2** | Encrypted media blobs (images, voice messages) — S3-compatible, zero egress fees |
| Session/Rate Limiting | **Cloudflare KV** | Session tokens, rate limit counters with TTL |
| Async Jobs | **Cloudflare Queue** | Push notification batching, async processing |
| Push Notifications | **APNs** (direct) + **FCM** (direct) | Direct to Apple/Google push servers — no third-party push service |
| Signaling (Calls) | **Durable Objects WebSockets** | WebRTC signaling for call setup — actual media is peer-to-peer |

### Web Frontend (Cloudflare Pages)

| Layer | Technology | Why |
|---|---|---|
| Language | **TypeScript** | Shared E2E crypto code with backend and mobile |
| Framework | **SPA** (vanilla TypeScript or SvelteKit) | Lightweight, fast, deploys to Pages |
| Crypto | **Web Crypto API** (built-in) | No third-party crypto libraries — browser-native AES-GCM, X25519, Ed25519 |

### iOS App

| Layer | Technology |
|---|---|
| Language | **Swift** |
| UI | **SwiftUI** |
| Crypto | **CryptoKit** (Apple built-in — X25519, AES-GCM, HKDF, Ed25519) |
| Networking | **URLSession** + native **WebSocket** (`URLSessionWebSocketTask`) |
| Calls | **WebRTC** via compiled `libwebrtc` (Google open-source) |
| Local Storage | **SwiftData** or **SQLite** (encrypted with SQLCipher or Data Protection) |

### Android App

| Layer | Technology |
|---|---|
| Language | **Kotlin** |
| UI | **Jetpack Compose** |
| Crypto | **java.security** / **javax.crypto** (built-in — AES/GCM, X25519 via XDH, HKDF) |
| Networking | **OkHttp** + built-in WebSocket support |
| Calls | **WebRTC** via Google's `libwebrtc` Android library |
| Local Storage | **Room** (with SQLCipher for encryption-at-rest) |

---

## 2. Roc Design System

### The Roc Brand Identity

All Roc apps share a **mythological Roc bird** mascot with a **"Desert Sky"** theme. The bird is a majestic golden eagle-like creature rendered in amber/gold gradients on a dark midnight background.

| App | Bird Variation | Accent Context |
|---|---|---|
| RocMail | Wings spread, turquoise feather accent | Envelope/mail motifs |
| RocPass | Wings spread, shield overlay behind bird | Shield/guardian motifs |
| **RocChat** | Wings spread, **speech bubble or signal wave overlay** | Chat/communication motifs |

### Core Color Palette

```
ROC Brand Colors (shared across all Roc apps):
───────────────────────────────────────────────
--roc-gold:       #D4AF37    ← Primary brand color
--roc-gold-light: #E8CC6E
--roc-gold-dark:  #A68B2A
--desert-sky:     #87CEEB    ← Secondary/accent
--ancient-ivory:  #F5F5DC    ← Light mode background base
--shadow-bronze:  #8B7355    ← Grounded neutral
--midnight-azure: #0D1117    ← Dark mode base / sidebar / icon bg
--turquoise:      #40E0D0    ← Highlight accent

Bird Gradient Palette (SVG):
──────────────────────────────
Body:    #fef3c7 → #f59e0b → #b45309
Wings:   #fbbf24 → #d97706 → #92400e → #451a03
Tail:    #d97706 → #78350f
Head:    #fffbeb → #fbbf24
Beak:    #fde68a → #fcd34d → #d97706
Eyes:    #fffbeb (white), #78350f (pupil)
Talons:  #78350f
```

### Light Theme Tokens

```css
:root {
  /* Surfaces */
  --bg-app:          #F5F3ED;
  --bg-sidebar:      #FEFCF6;
  --bg-card:         #FEFCF6;
  --bg-card-hover:   #FAF7EF;
  --bg-elevated:     #FFFFFF;
  --bg-input:        #FEFCF6;

  /* Chat-specific surfaces */
  --bg-bubble-mine:       rgba(212, 175, 55, 0.12);
  --bg-bubble-theirs:     #FEFCF6;
  --bg-bubble-mine-hover: rgba(212, 175, 55, 0.18);

  /* Text */
  --text-primary:   #1A1A2E;
  --text-secondary: #5C5A6E;
  --text-tertiary:  #706D7B;
  --text-inverse:   #FFFFFF;

  /* Borders — Shadow Bronze tones */
  --border-weak:   #E8E2D4;
  --border-norm:   #D6CEBC;
  --border-strong: #C4BAA6;

  /* Semantic */
  --success: #1EA672;
  --danger:  #DC3545;
  --warning: #E5A00D;
  --info:    #2D8CFF;

  /* ROC Brand */
  --roc-gold:       #D4AF37;
  --roc-gold-light: #E8CC6E;
  --roc-gold-dark:  #A68B2A;
  --desert-sky:     #87CEEB;
  --ancient-ivory:  #F5F5DC;
  --shadow-bronze:  #8B7355;
  --midnight-azure: #0D1117;
  --turquoise:      #40E0D0;

  /* Primary/Accent tokens */
  --primary:       #D4AF37;
  --primary-hover: #C9A230;
  --primary-light: #E8CC6E;
  --primary-bg:    rgba(212, 175, 55, 0.08);
  --primary-glow-sm: 0 2px 8px rgba(212, 175, 55, 0.25);
  --primary-glow-md: 0 4px 16px rgba(212, 175, 55, 0.3);

  /* Surfaces (Roc-style) */
  --surface-primary:   rgba(255, 253, 245, 0.95);
  --surface-secondary: rgba(255, 253, 245, 0.8);
  --surface-elevated:  rgba(255, 253, 245, 0.92);
  --surface-solid:     #FFFDF5;

  /* Sidebar */
  --sidebar-bg:     #0D1117;
  --sidebar-hover:  rgba(212, 175, 55, 0.12);
  --sidebar-active: rgba(212, 175, 55, 0.2);
  --sidebar-border: rgba(212, 175, 55, 0.1);
}
```

### Dark Theme Tokens

```css
.dark {
  --bg-app:     #151210;
  --bg-sidebar: #110E0C;
  --bg-card:    #1C1814;
  --bg-elevated: #1C1814;
  --bg-input:   rgba(212, 175, 55, 0.06);

  --bg-bubble-mine:   rgba(212, 175, 55, 0.15);
  --bg-bubble-theirs: #1C1814;

  --text-primary:   #E8E2D4;
  --text-secondary: #A09888;
  --text-tertiary:  #706860;

  --border-weak:   rgba(139, 115, 85, 0.12);
  --border-norm:   rgba(139, 115, 85, 0.18);
  --border-strong: rgba(139, 115, 85, 0.32);

  --surface-primary:   rgba(21, 18, 16, 0.95);
  --surface-secondary: rgba(21, 18, 16, 0.8);
  --surface-elevated:  rgba(28, 24, 20, 0.92);
  --surface-solid:     #1C1814;

  --sidebar-bg:     #110E0C;
  --sidebar-hover:  rgba(212, 175, 55, 0.1);
  --sidebar-active: rgba(212, 175, 55, 0.18);

  --shadow-card: 0 8px 30px rgba(0, 0, 0, 0.3);
  --shadow-modal: 0 25px 60px rgba(0, 0, 0, 0.5), 0 10px 30px rgba(212, 175, 55, 0.05);
}
```

### Typography

- **Primary font**: `Montserrat` (matching RocMail)
- **Monospace**: `JetBrains Mono` / `SF Mono, Fira Code` — for timestamps, encryption indicators
- **Display/serif**: `Georgia` — for branding moments only
- **Font sizes**: xs=0.6875rem, sm=0.8125rem, base=0.9375rem, lg=1.0625rem, xl=1.25rem, 2xl=1.5rem, 3xl=1.875rem

### Spacing & Radius

```
Spacing: 4px base grid (4, 8, 12, 16, 20, 24, 32, 40, 48, 64)
Radius:  xs=4  sm=6  md=8  lg=12  xl=16  2xl=20  full=9999
Chat bubbles: radius-lg (12px) with one squared corner (2px)
```

### Shadows (Warm Golden)

```css
--shadow-xs:    0 1px 2px rgba(139, 115, 85, 0.06);
--shadow-sm:    0 1px 3px rgba(139, 115, 85, 0.08), 0 1px 2px rgba(139, 115, 85, 0.04);
--shadow-md:    0 4px 12px rgba(139, 115, 85, 0.1);
--shadow-lg:    0 8px 24px rgba(139, 115, 85, 0.12);
--shadow-xl:    0 16px 48px rgba(139, 115, 85, 0.14);
--shadow-focus: 0 0 0 3px rgba(212, 175, 55, 0.2);
```

### Transitions & Motion

```css
--ease-out:           cubic-bezier(0.16, 1, 0.3, 1);
--ease-in-out:        cubic-bezier(0.4, 0, 0.2, 1);
--duration-fast:      120ms;
--duration-base:      200ms;
--duration-normal:    250ms;
--duration-slow:      350ms;
--transition-spring:  0.5s cubic-bezier(0.34, 1.56, 0.64, 1);
```

`prefers-reduced-motion` is always respected with instant fallback.

### UI Pattern Consistency

| Pattern | Implementation |
|---|---|
| Navigation | Sidebar on desktop (260px, collapsible to 64px rail), bottom nav on mobile |
| Sidebar background | Dark (`#0D1117` / `#110E0C`) even in light mode |
| Active nav item | `rgba(212, 175, 55, 0.2)` gold tint highlight |
| Hover states | `rgba(212, 175, 55, 0.06)` subtle gold |
| Loading screen | Animated Roc bird with security rings + gold gradient title text + ambient particles |
| Login screen | Centered Roc bird icon + app name in gradient gold text |
| Selection highlight | `rgba(212, 175, 55, 0.2)` |
| Focus ring | `0 0 0 3px rgba(212, 175, 55, 0.2)` |
| Icons | Lucide (web), SF Symbols (iOS), Material Icons (Android) |
| Theme toggle | Light / Dark / Auto / Scheduled |
| Safe area | `env(safe-area-inset-*)` padding for notched devices |
| PWA manifest | `theme_color: "#D4AF37"`, `background_color: "#151210"` |

### Chat-Specific Design Elements

```
Message bubbles:
  Mine  → Gold-tinted (--bg-bubble-mine), rounded with bottom-right corner squared
  Theirs → Ivory/card bg, rounded with bottom-left corner squared
  Border radius: 12px (with 2px on the "tail" corner)

Encryption indicator:
  Small lock icon in turquoise (#40E0D0) next to timestamps
  "End-to-end encrypted" banner in muted text with turquoise lock

Call UI:
  Full-screen dark (#0D1117) background
  Gold ring around caller avatar (pulsing during ring)
  Accept: turquoise (#40E0D0) button
  Decline: danger (#DC3545) button

Online presence:
  Online dot: #1EA672 (success green)
  Typing indicator: gold dots animation with spring easing

Delivery status:
  ✓  Sent
  ✓✓ Delivered
  ✓✓ Read (blue tint, if enabled by recipient)
  🕐 Queued (offline)
  ⟳  Syncing...
```

### Swift (iOS) — Color Implementation

```swift
extension Color {
    static let rocGold       = Color(hex: "D4AF37")
    static let rocGoldLight  = Color(hex: "E8CC6E")
    static let rocGoldDark   = Color(hex: "A68B2A")
    static let desertSky     = Color(hex: "87CEEB")
    static let ancientIvory  = Color(hex: "F5F5DC")
    static let shadowBronze  = Color(hex: "8B7355")
    static let midnightAzure = Color(hex: "0D1117")
    static let turquoise     = Color(hex: "40E0D0")
    static let bubbleMine    = Color.rocGold.opacity(0.12)
    static let bubbleTheirs  = Color(hex: "FEFCF6")
}
```

### Kotlin (Android) — Color Implementation

```kotlin
object RocColors {
    val RocGold       = Color(0xFFD4AF37)
    val RocGoldLight  = Color(0xFFE8CC6E)
    val RocGoldDark   = Color(0xFFA68B2A)
    val DesertSky     = Color(0xFF87CEEB)
    val AncientIvory  = Color(0xFFF5F5DC)
    val ShadowBronze  = Color(0xFF8B7355)
    val MidnightAzure = Color(0xFF0D1117)
    val Turquoise     = Color(0xFF40E0D0)
    val BubbleMine    = RocGold.copy(alpha = 0.12f)
    val BubbleTheirs  = Color(0xFFFEFCF6)
}
```

---

## 3. App Icon & Badges

### App Icon

512×512, rx=112 rounded rect. Background: `#0D1117 → #161B22` gradient. Gold radial glow behind bird. Subtle gold inner border `rgba(212,175,55,0.15)`. Same Roc bird centered. Chat-specific overlay: small speech bubble or signal waves near the bird's beak in turquoise (#40E0D0) or gold (#D4AF37) at ~20% opacity.

### Premium Badge — Golden Roc Wings

- A pair of small golden wings wrapping the bottom of the avatar circle
- Avatar border ring: 2px solid `#D4AF37`
- Wing gradient: `#fbbf24 → #d97706 → #92400e` (same as Roc bird wings)
- Ambient glow: radial `#D4AF37` at 15% opacity, 4px spread
- Animation: gentle breathing pulse (scale 1.0 → 1.02, 3s ease loop)
- Optional shimmer: subtle light sweep across wings (CSS, 4s interval)

### Business Badge — Crowned Roc with Shield

- Full Roc bird silhouette perched on a shield with a small crown/crest
- Avatar border ring: 2.5px gradient stroke `#fbbf24` (top) → `#b45309` (bottom)
- Crown/crest: 3 small feather points above avatar (center 8px tallest, sides 5px angled), gradient `#fde68a → #d97706`
- Wings: fuller than Premium, 4 visible feather segments per wing, gradient `#fbbf24 → #d97706 → #92400e → #451a03`
- Shield badge (bottom): gradient `#d97706 → #92400e → #161B22`, contains org initial or small Roc silhouette, 1px `#fbbf24` at 40% border
- Ambient glow: `#D4AF37` at 22% opacity, 6px spread, slow rotation (8s loop)

### Donor Badges — Roc Feathers

| Tier | Price | Feather | Color |
|---|---|---|---|
| ☕ Coffee | $3 | Single bronze feather (12px) | `#8B7355` |
| 🪶 Feather | $5 | Single amber feather (14px) | `#d97706 → #92400e` |
| 🦅 Wing | $10 | Golden feather (16px, shimmer) | `#fbbf24 → #d97706` |
| 🏔️ Mountain | $25 | Radiant golden feather (18px, glow) | `#fef3c7 → #f59e0b → #b45309` |
| 👑 Patron | $50 | Turquoise-tipped golden feather (20px) | Body: `#fbbf24 → #d97706`, Tip: `#40E0D0` |

Recurring donors get a subtle ∞ loop at feather base. Badge display is togglable in settings.

---

## 4. E2E Encryption Architecture

### Encryption Coverage Matrix

| Data Type | Encryption Method | Key Exchange | Server Sees |
|---|---|---|---|
| Text messages | AES-256-GCM | Double Ratchet (per-message keys) | Encrypted blob + size |
| Media/files | AES-256-GCM (random file key, key sent in message) | File key wrapped in message encryption | Encrypted blob in R2 |
| Voice calls | SRTP (WebRTC DTLS-SRTP) + additional E2E layer | ECDH via signaling channel (encrypted) | Nothing — P2P direct |
| Video calls | SRTP (WebRTC DTLS-SRTP) + additional E2E layer | ECDH via signaling channel (encrypted) | Nothing — P2P direct |
| Call signaling | AES-256-GCM (SDP/ICE encrypted before relay) | Double Ratchet (same as messages) | Encrypted signaling blobs |
| Profile data | AES-256-GCM | Vault key (derived from passphrase) | Encrypted blob |
| Group metadata | AES-256-GCM | Group key (distributed via pairwise channels) | Encrypted blob |
| Read receipts | AES-256-GCM | Double Ratchet | Encrypted blob |
| Typing indicators | Ephemeral, encrypted in WebSocket frame | Session key | Encrypted |
| Presence (online/offline) | Encrypted per-contact | Per-contact key | Encrypted |
| Push notification payload | AES-256-GCM (content-hidden push) | Device push key | "New message" only — no content |
| Local database (device) | SQLCipher (SQLite) / iOS Data Protection | Derived from passphrase | N/A — on device |
| Key backup blob | AES-256-GCM | Recovery phrase → HKDF | Encrypted blob |

**The server is a blind relay. It processes nothing, reads nothing, decrypts nothing.**

### Encryption Primitives

| Primitive | Algorithm | Platform Implementation |
|---|---|---|
| Key Exchange | X25519 (Curve25519 ECDH) | Web Crypto API / CryptoKit / javax.crypto |
| Signing | Ed25519 | Web Crypto API / CryptoKit / javax.crypto |
| Symmetric | AES-256-GCM | Web Crypto API / CryptoKit / javax.crypto |
| Key Derivation | HKDF-SHA256 | Web Crypto API / CryptoKit / javax.crypto |
| Password Hash | Argon2id (WASM) or PBKDF2-SHA256 (native) | WASM in Workers+Web / native on mobile |
| Content Hash | SHA-256 (file integrity) | All platforms natively |
| Safety Numbers | SHA-512 (truncated, numeric display) | All platforms natively |
| Message Protocol | Double Ratchet (1:1), Sender Keys (groups) | Custom implementation per platform |
| Call Encryption | DTLS-SRTP (WebRTC) + E2E signaling | libwebrtc |
| Local DB | SQLCipher (Android) / Data Protection (iOS) / IndexedDB + AES (Web) | Platform native |

**ZERO third-party crypto libraries. Every primitive uses platform-native implementations.**

### Signal Protocol Implementation (Self-Built)

#### X3DH Key Agreement (Initial Handshake)

Used when two users first establish a conversation:
1. Each user publishes a **key bundle** to the server: Identity Key (Ed25519), Signed Pre-Key (X25519, rotated periodically), batch of One-Time Pre-Keys (X25519, single-use)
2. Initiator fetches recipient's bundle, performs 3 or 4 DH operations
3. Derives shared secret via HKDF
4. First message includes initiator's ephemeral public key so recipient can compute the same secret

#### Double Ratchet (Per-Message Forward Secrecy)

After X3DH establishes the initial shared secret:
1. **Symmetric ratchet**: each message derives a new key from the previous chain key (HMAC-based)
2. **DH ratchet**: when receiving a new DH public key from the other party, perform new DH and reset the chain
3. Each message encrypted with a unique key — compromise of one key reveals only one message
4. Forward secrecy: past messages cannot be decrypted even if current keys are compromised

#### Sender Keys (Group E2E)

For group chats (more than 2 members):
1. Each member generates a Sender Key per group
2. Distributes it to all other members via pairwise Double Ratchet channels
3. Encrypt once with sender's Chain Key (AES-256-GCM)
4. Server fans out the single ciphertext
5. Each recipient decrypts with sender's key
6. Performance: O(1) encrypt instead of O(n)
7. Sender Key rotated when any member leaves the group

### Message Encryption Flow

1. Ratchet forward → new Message Key
2. Plaintext = `{ type, body, timestamp, reply_to, ... }`
3. Ciphertext = `AES-256-GCM(key: MessageKey, iv: random 12 bytes, aad: sender_id || recipient_id || msg_counter, plaintext)`
4. Envelope = `{ sender_id, conversation_id, ratchet_header, ciphertext, iv, tag }`
5. Server stores envelope as-is. Cannot read body.

### File Encryption Flow

1. Generate random FILE KEY (256-bit) and FILE IV (96-bit)
2. Compute FILE HASH = SHA-256(plaintext)
3. Encrypt: AES-256-GCM(key: FILE KEY, iv: FILE IV, plaintext: raw file bytes)
4. Upload encrypted file to R2 → get blob_id
5. Send message via Double Ratchet containing: `{ type: "file", blob_id, file_key, file_iv, file_hash, filename, mime, size }`
6. Recipient: decrypts message → gets file_key → downloads encrypted blob from R2 → decrypts locally → verifies SHA-256

### What Server Can See (Worst Case — Full Compromise)

| Data | Visible? |
|---|---|
| Who sent a message to which conversation ID | Yes (needed for routing) |
| Message content | No |
| File content | No |
| Call audio/video | No (peer-to-peer) |
| Call metadata (who called whom) | Encrypted signaling — only conversation_id visible |
| Timestamps (server arrival) | Yes |
| User IP address | Cloudflare sees for TCP, but NOT logged |
| Username ↔ UUID mapping | Yes (needed for search) |
| Contact list / who talks to whom | Conversation IDs visible, but membership encrypted |
| Group names / members | No (encrypted metadata) |
| Profile photos | No (encrypted in R2) |
| Read receipts | No |
| Typing indicators | No (ephemeral + encrypted) |
| Online status | Encrypted per-contact |

---

## 5. Authentication System

### Zero-Knowledge Auth — No Phone, No Email, Ever

#### Registration Flow

1. User downloads app / opens web client
2. Picks:
   - **Username** (unique handle, e.g. `@noor`) — only identifier, no PII
   - **Display name** (e.g. "Noor A.")
   - **Passphrase** (min 4 words or 16 chars, user-chosen or auto-generated diceware)
3. Anti-abuse (private):
   - **Cloudflare Turnstile** (CAPTCHA alternative — no cookies, no fingerprinting)
   - Rate limit: max 5 signups per IP per hour
   - Optional: proof-of-work challenge (hashcash-style)
4. Client-side key generation:
   - AUTH key = `Argon2id(passphrase, salt)` (or PBKDF2-SHA256 with 600,000 iterations)
   - Identity Key Pair (Ed25519)
   - Signed Pre-Key + batch of One-Time Pre-Keys (X25519)
   - Vault key = `HKDF(passphrase, "vault-encryption")` encrypts all private keys
5. Server stores: `user_id (UUID) | username | auth_hash | salt | encrypted_keys | public_key_bundle | created_at`

**Server NEVER sees: passphrase, private keys, plaintext of anything.**

#### Login Flow

1. User enters username + passphrase
2. Client derives AUTH key from passphrase
3. Server verifies auth_hash → returns encrypted key blob + session token
4. Client decrypts private keys locally using vault key derived from passphrase

#### Recovery

- **12-word recovery phrase** (BIP39-style mnemonic) shown once at signup — reconstructs vault key
- **Device-to-device transfer** — if one device still has access, QR scan transfers keys
- **Admin re-invite** — user re-registers (loses server-side history, local history intact on other devices)

**No server-side password reset by design.**

#### Multi-Device

Each device is a first-class client. No "primary device." No phone dependency.

1. Open RocChat on new device
2. Log in with passphrase
3. Existing device shows 6-digit verification code
4. Enter code on new device → keys transferred via encrypted channel
5. All messages sync (encrypted in D1)

Device management in Settings shows all devices with last-active time and ability to revoke any device instantly.

---

## 6. Voice & Video Calls

### 3-Layer Call Encryption

#### Layer 1 — Signaling (Call Setup)

SDP offers/answers and ICE candidates are encrypted using the Double Ratchet channel BEFORE being sent through the Durable Object relay:

```
signal_msg = DoubleRatchet.encrypt({
  type: "call_offer",
  sdp: "v=0\r\no=- ...",
  call_id: "uuid",
  call_type: "video"
})
```

Server relays encrypted blob. Cannot see SDP or ICE candidates (cannot know IP addresses of peers).

#### Layer 2 — WebRTC Transport (DTLS-SRTP)

WebRTC's built-in DTLS handshake establishes SRTP keys for media encryption. Peer-to-peer. Audio/video frames encrypted with AES-128-CTR (SRTP).

#### Layer 3 — Verification (MitM Protection)

After DTLS handshake, both peers:
1. Extract DTLS fingerprint from the SDP
2. Compare against fingerprint received via the E2E-encrypted signaling channel
3. Display Safety Number: `SHA-256(sorted(identity_key_A, identity_key_B))` — shown as numeric code or QR

#### TURN Fallback

For NAT traversal failures, use Cloudflare TURN service or self-hosted TURN server. Media still encrypted with SRTP. TURN server sees encrypted packets only.

#### Group Calls

- **Mesh topology** (up to ~6 participants): each pair has own DTLS-SRTP channel
- **SFU mode** (larger groups): SFU relays encrypted frames using insertable streams / SFrame — SFU cannot decrypt media

---

## 7. Contact Discovery

### Method 1: QR Code

QR encodes: `{ "u": "username", "k": "base64(identity_pub)", "v": 1 }`

1. User A shows QR in app (Settings → My QR Code)
2. User B scans with RocChat camera
3. App verifies identity key matches server's key bundle
4. Contact request sent (encrypted)
5. User A approves → X3DH session established
6. Both users have **verified** Safety Number (QR scan = "trusted" badge)

### Method 2: Username Search

1. User B types exact username: `@noor`
2. Server checks: does user exist AND have discovery set to "Everyone"?
3. If yes → returns: username, display_name, (encrypted) profile photo, identity_public_key
4. User B sends contact request
5. User A approves → X3DH session established
6. Shown as "unverified" until Safety Numbers verified in person

Privacy:
- Search queries NOT logged
- Same response time for existing and non-existing users (prevents enumeration)
- Rate limited: 10 searches/min
- No "suggested contacts" or "people nearby"

### Method 3: Invite Link

User generates: `rocchat.app/add/@noor?k=base64(pub_key)`. Share via any channel. Recipient opens in app. Same flow as QR but via link.

### Safety Numbers

For each contact pair: `safety_number = SHA-512(sort(identity_key_A, identity_key_B))`

Displayed as 12-group numeric code or scannable QR. States:
- 🔒 Encrypted (always — E2E is mandatory)
- ✅ Verified (QR scanned or Safety Number compared)
- ⚠️ Key changed (identity key rotated — re-verify)

---

## 8. Privacy Settings

Per-user privacy controls:

| Setting | Options |
|---|---|
| Who can find me by username? | Everyone / Nobody (QR + link only) |
| Who can add me? | Everyone / QR code only |
| Show online status to | Everyone / My contacts only / Nobody |
| Show read receipts | On / Off |
| Show typing indicator | On / Off |

Per-conversation notification controls:

| Mode | Behavior |
|---|---|
| Normal | All notifications |
| Quiet | Badge count only, no sound/vibration |
| Focus | Only when @mentioned or replied to |
| Emergency only | Calls ring, messages silent |
| Silent | Nothing visible until you open app |
| Scheduled | Only deliver between configured hours |

DND with exceptions:
- Allow calls from "Favorites"
- Allow messages containing keywords (e.g. "emergency", "urgent")

---

## 9. Competitive Features

### 9.1 One-Tap Import / Migration Bridge

Import from WhatsApp, Telegram, Signal (from exported .zip/.json):
- Re-encrypts locally with RocChat keys
- Contacts matched by username (invite others)
- Generates invite links for contacts not yet on RocChat
- Old messages searchable but marked as "imported"
- Original timestamps preserved
- Media re-encrypted into R2

### 9.2 Disappearing Everything

Per-conversation settings:
- Messages: off / 1h / 24h / 7d / 30d / custom (Premium)
- Media: off / after viewed / 1h / 24h
- Voice notes: off / after played / 1h
- Call history: off / 24h / 7d
- "Burn on read": disappears from BOTH devices after read
- Screenshot detection → sender notified (iOS/Android native API)

**Ghost Mode**: Toggle ON → all outgoing messages auto-expire in 24h, no presence, no typing indicators, no read receipts.

### 9.3 Radically Simple UI — 3 Tabs

```
┌───────────┬───────────┬─────────────┐
│   Chats   │   Calls   │   Settings  │
└───────────┴───────────┴─────────────┘
```

No stories. No channels. No bots. No AI. No payments. No shopping. No ads. Just messaging done perfectly.

### 9.4 True Multi-Device E2E

Each device is first-class. No primary device. No phone dependency. Add device via passphrase + 6-digit verification code from existing device. Revoke any device instantly. No SIM swap attack vector.

### 9.5 Encrypted Vault Sharing (Borrows from RocPass DNA)

Share sensitive items in-conversation:
- Passwords → auto-expire after 1 view
- WiFi credentials → tap to copy, auto-expire
- Credit card → masked display, tap to reveal
- Secure notes → encrypted, pinned in chat
- Files → encrypted, download-once option

### 9.6 Offline-First Architecture

- Compose messages offline → queued & sent when connection returns
- Browse all history offline (encrypted local DB)
- Search messages offline
- View all cached media
- New contacts queued until online

### 9.7 Open Protocol + Auditable

- Client code: fully open source (MIT license)
- Server code: fully open source
- Encryption protocol: published specification document
- Independent security audits (annual, published publicly)
- Reproducible builds (verify App Store binary matches source)
- Warrant canary page: `rocchat.app/canary`

### 9.8 Universal App

| Platform | Experience |
|---|---|
| iOS | Native Swift/SwiftUI |
| Android | Native Kotlin/Compose |
| Web | Progressive Web App (Cloudflare Pages) |
| macOS | Native (Catalyst or SwiftUI) |
| Windows | PWA installable from web |
| Linux | PWA installable from web |

Same account, same passphrase, instant sync, full E2E encryption. No phone needed.

### The Minimalism Manifesto

RocChat is NOT: a social network, a content platform, a marketplace, an AI assistant, a business tool, an ad platform.

RocChat IS: Messages, Calls, Groups, Encrypted, Private, Beautiful, Fast.

---

## 10. Pricing Tiers & Donations

### Free — $0 Forever

```
✅ Unlimited 1:1 messaging (text, voice notes, media)
✅ Unlimited 1:1 voice & video calls
✅ E2E encryption on everything (non-negotiable, same as paid)
✅ Groups up to 50 members
✅ Group voice calls up to 5 participants
✅ 2 GB media storage
✅ 3 devices per account
✅ Disappearing messages (basic: 24h/7d/30d)
✅ QR code + username discovery
✅ Offline mode
✅ Message search
✅ Dark/light theme
✅ Chat import from WhatsApp/Telegram/Signal
```

### RocChat Premium — $4.99/month or $39.99/year ($3.33/mo effective)

```
Everything in Free, plus:
⭐ Groups up to 500 members
⭐ Group video calls up to 20 participants
⭐ 50 GB media storage
⭐ 10 devices per account
⭐ Encrypted Vault sharing (passwords, cards, notes, files)
⭐ "View once" media with screenshot detection
⭐ Scheduled messages (send later)
⭐ Chat folders / organization
⭐ Custom chat themes (within Roc Design System palette)
⭐ Priority message delivery
⭐ Extended disappearing options (1h, 6h, 12h, 24h, 7d, 30d, custom)
⭐ Advanced notification controls (keyword alerts, scheduled quiet hours)
⭐ Golden Roc Wings badge on profile
⭐ Early access to new features
⭐ Email support (48h response)
```

### RocChat Business — $3.99/user/month (min 5 users)

Volume discounts: 5-25 users $3.99, 26-100 $2.99, 101-500 $1.99, 500+ custom.

```
Everything in Premium, plus:
🏢 Admin dashboard (manage users, permissions, devices)
🏢 Groups up to 5,000 members
🏢 Group video calls up to 50 participants
🏢 500 GB shared media storage (pooled)
🏢 Unlimited devices per user
🏢 Organization directory (internal user lookup)
🏢 Role-based access (admin, moderator, member)
🏢 User provisioning (admin invites, bulk onboard)
🏢 Remote device wipe
🏢 Compliance export (encrypted audit logs)
🏢 Message retention policies
🏢 Custom branding (org logo, color accent)
🏢 Crowned Roc with Shield badge
🏢 Priority support (24h response SLA)
🏢 SSO integration (SAML/OIDC)
🏢 API access (webhooks for integration)
```

### Donations

In-app (Settings → Support RocChat):

| Tier | Price | Badge |
|---|---|---|
| ☕ Buy Roc a Coffee | $3 | Single bronze feather |
| 🪶 Feather Supporter | $5 | Single amber feather |
| 🦅 Wing Supporter | $10 | Golden feather (shimmer) |
| 🏔️ Mountain Guardian | $25 | Radiant golden feather (glow) |
| 👑 Roc Patron | $50 | Turquoise-tipped golden feather |
| 💎 Custom amount | $___  | Based on nearest tier |

One-time or monthly recurring. Supporters get optional profile badge and optional name on public supporters wall.

Payment methods: Apple IAP (iOS), Google Play (Android), Stripe (web), Crypto (BTC, ETH, XMR).

Monthly transparency report published with aggregate revenue and infrastructure costs.

### Rule: Encryption and privacy are NEVER paywalled. Free users get the same encryption as Business users. Always.

---

## 11. Architecture & Infrastructure

### Cloudflare Infrastructure

```
┌──────────────────────────────────────────────────────────────┐
│                    CLOUDFLARE INFRASTRUCTURE                   │
│                                                                │
│  Workers (API) ──▶ Durable Objects (WebSocket per convo)       │
│       │                                                        │
│       │            D1 (User data, messages, key bundles)       │
│       │            Sharded by user_id hash                     │
│  Queue ◀──────     R2 (Encrypted media blobs)                  │
│  (Push batching)   KV (Sessions, rate limit counters)          │
│                                                                │
│  Cloudflare Pages (Web client SPA)                             │
└──────────────────────────────────────────────────────────────┘
```

### Rate Limiting

| Resource | Limit |
|---|---|
| Messages | 60/min, 1000/hour per user |
| Media upload | 20/hour, 100MB/day per user |
| Calls | 10/hour per user |
| Key requests | 30/min (pre-key fetches) |
| Signup | 5/IP/hour (via Turnstile) |
| Username search | 10/min per user |

### Scaling Cost Estimates

| Scenario | Users | Est. Monthly Cost |
|---|---|---|
| Early stage | 1,000 | ~$5-20 |
| Growing | 10,000 | ~$50-150 |
| Traction | 100,000 | ~$200-500 |
| Scale | 1,000,000 | ~$2,000-5,000 |

---

## 12. Project Structure

```
RocChat/
├── ROCCHAT-SPEC.md             # This file
├── backend/                    # Cloudflare Workers (TypeScript)
│   ├── src/
│   │   ├── index.ts           # Router + Worker entrypoint
│   │   ├── auth.ts            # Registration, login, session management
│   │   ├── messages.ts        # Store/retrieve encrypted messages
│   │   ├── keys.ts            # Public key bundle management (X3DH)
│   │   ├── contacts.ts        # Discovery, QR, username search
│   │   ├── signaling.ts       # WebRTC signaling for calls
│   │   ├── media.ts           # R2 upload/download encrypted media
│   │   ├── rate-limit.ts      # KV-based rate limiting
│   │   └── durable-objects/
│   │       └── ChatRoom.ts    # WebSocket hub per conversation
│   ├── migrations/            # D1 schema migrations
│   ├── wrangler.toml
│   └── package.json
│
├── shared/                     # Shared E2E crypto logic (TypeScript)
│   ├── x3dh.ts                # X3DH key agreement
│   ├── double-ratchet.ts      # Double Ratchet algorithm
│   ├── sender-keys.ts         # Sender Keys for groups
│   ├── crypto-utils.ts        # AES-GCM, HKDF, X25519 wrappers
│   └── protocol.ts            # Message format types
│
├── web/                        # Cloudflare Pages (TypeScript SPA)
│   ├── src/
│   │   ├── index.html
│   │   ├── app.ts
│   │   ├── styles/            # Roc Design System CSS
│   │   ├── chat/              # Chat UI components
│   │   ├── calls/             # Call UI
│   │   ├── auth/              # Login / Register screens
│   │   └── crypto/            # Imports from shared/
│   └── package.json
│
├── ios/                        # Native iOS (Swift + SwiftUI)
│   └── RocChat/
│       ├── RocChatApp.swift
│       ├── Crypto/            # CryptoKit implementation of protocol
│       ├── Chat/
│       ├── Calls/             # WebRTC integration
│       ├── Auth/
│       └── Assets.xcassets/   # Roc-family design assets
│
└── android/                    # Native Android (Kotlin + Compose)
    └── app/src/main/
        ├── kotlin/.../rocchat/
        │   ├── crypto/        # javax.crypto implementation
        │   ├── chat/
        │   ├── calls/         # WebRTC integration
        │   ├── auth/
        │   └── ui/            # Jetpack Compose screens
        └── res/               # Roc-family design assets
```

---

*This specification captures every decision made during the design phase of RocChat. All implementations must follow this document.*
