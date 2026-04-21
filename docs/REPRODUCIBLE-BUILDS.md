# Reproducible Builds

We are working toward bit-for-bit reproducible builds across all
platforms. This document tracks current status, the verification recipe
per platform, and the remaining gaps.

## Status

| Platform | Reproducible? | Notes |
|----------|---------------|-------|
| Web (Vite bundle) | ✅ Yes | Output is deterministic if `node_modules` is reproduced from `package-lock.json` and `SOURCE_DATE_EPOCH` is set. |
| Backend (Workers) | ✅ Yes | Wrangler bundles to a single ESM file. Same inputs → same output. |
| Android (debug)   | ⚠️ Partial | APK shell is reproducible, but the `META-INF/CERT.RSA` signing block embeds the developer key. Use `apksigner verify --print-certs` to compare keys; use `apkdiff` to compare unsigned content. |
| Android (release) | ❌ Not yet | Needs deterministic R8 shrinking + stripped resource ordering. Tracked. |
| iOS               | ⚠️ Partial | Xcode embeds build timestamps and the developer team ID into the `Info.plist`. Reproducible up to the signature block when the same Xcode/Swift versions are used. Apple does not yet support fully reproducible code signing. |

## Web — verify

```sh
cd web
SOURCE_DATE_EPOCH=$(git log -1 --format=%ct) \
  npm ci && npm run build
sha256sum dist/assets/*.js dist/assets/*.css | sort
```

Two clean checkouts on two machines should produce the same hashes
provided `node` and `npm` versions match.

## Backend — verify

```sh
cd backend
npm ci
npx wrangler deploy --dry-run --outdir=dist
sha256sum dist/index.js
```

## Android — verify

```sh
cd android
./gradlew assembleDebug
unzip -p app/build/outputs/apk/debug/app-debug.apk classes.dex \
  | sha256sum
```

The class data is reproducible. Comparing two APK ZIPs requires
`diffoscope` because zip metadata (timestamps, file ordering) varies.

```sh
diffoscope app-debug.apk other-app-debug.apk
```

## iOS — verify

```sh
cd ios
xcodegen generate
xcodebuild \
  -project RocChat.xcodeproj \
  -scheme RocChat \
  -sdk iphoneos \
  -configuration Release \
  archive -archivePath build/RocChat.xcarchive
shasum -a 256 build/RocChat.xcarchive/Products/Applications/RocChat.app/RocChat
```

The `__TEXT` segment is reproducible across builds with the same Xcode
toolchain. Code signature, embedded provisioning profile, and the
`Info.plist` build timestamp differ. We accept this gap until Apple ships
deterministic code signing.

## CI verification

The `ci` workflow ([.github/workflows/ci.yml](.github/workflows/ci.yml))
builds all four platforms on every push and PR. To strengthen this into
true reproducibility verification, we would need to:

1. Build twice in two clean GitHub runners.
2. Compare artifacts with `diffoscope`.
3. Fail CI on any unexplained diff.

This is tracked as a follow-up.

## What we **do not** promise

- Reproducible signed App Store / Play Store builds. The signing process
  is not under our control.
- Reproducibility across Xcode major versions (e.g. 16.0 vs 16.1).
  Always compare with the same toolchain.
