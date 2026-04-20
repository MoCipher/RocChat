# RocChat Desktop

Tauri 2.0 desktop app — wraps the RocChat web frontend in a native shell.

## Features

- Native window with system tray icon
- OS notifications via `tauri-plugin-notification`
- Auto-start on login via `tauri-plugin-autostart`
- Deep link handling (`rocchat://`) via `tauri-plugin-deep-link`
- ~5 MB binary (vs Electron's 200+ MB)

## Prerequisites

- [Rust](https://rustup.rs/) (stable)
- [Node.js](https://nodejs.org/) 18+
- Platform build tools:
  - **macOS**: Xcode Command Line Tools
  - **Windows**: Visual Studio Build Tools + WebView2
  - **Linux**: `webkit2gtk-4.1`, `libappindicator3-dev`, `librsvg2-dev`

## Development

```bash
# From the desktop/ directory
npm install
npm run dev
```

## Build

```bash
npm run build
```

Outputs:
- **macOS**: `src-tauri/target/release/bundle/dmg/RocChat_1.0.0_aarch64.dmg`
- **Windows**: `src-tauri/target/release/bundle/msi/RocChat_1.0.0_x64_en-US.msi`
- **Linux**: `src-tauri/target/release/bundle/appimage/RocChat_1.0.0_amd64.AppImage`
