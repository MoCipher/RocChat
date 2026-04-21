# Roc Client (canary channel)

Roc Client is RocChat's opt-in **canary release channel**. The marketing
name and icon (a stylised roc bird) are surfaced wherever the user opts
in.

## Why a separate name?

We want users on the canary channel to know — at a glance, in the title
bar, in the favicon, and in About — that they are running the
experimental build. "Roc Client" is the branding for that surface.
The bundle, the codebase, and the install target are still **RocChat**.

## How to opt in

Web:
1. Settings → Roc Client → toggle on.
2. The favicon swaps to `roc-client-icon.svg` and the document title is
   suffixed with `· Roc Client`.

The choice is persisted server-side per user (`KV` key `canary:<userId>`),
mirrored to `localStorage` for cold-start UX.

## Endpoints

`GET /api/canary` → `{ enabled: boolean, channel: 'stable' | 'roc' }`
`POST /api/canary` body `{ enabled: boolean }` → `{ ok: true, enabled }`

## Gating new features

```ts
import { isRocClient } from './components/roc-client.js';

if (isRocClient()) {
  // experimental UI
}
```

## Mobile

iOS and Android currently honour the same flag for **server-driven**
features (anything the backend toggles based on the canary KV value),
but do not yet swap their app icons. That requires alternate
icon entitlements (iOS `UIPrerenderedIcon` + alternate icon set, Android
activity-alias trick) and is tracked as a follow-up.

## Promoting a build

When a Roc Client feature graduates:

1. Remove the `isRocClient()` guard.
2. Bump the SW cache version (`web/public/sw.js`, `CACHE_NAME`).
3. Deploy.

There is no separate Pages project — same bundle serves both channels;
only the `data-channel` attribute on `<html>` differs.
