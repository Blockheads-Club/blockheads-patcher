<p align="center">
  <img width="120" height="120" src="app/static/icon-512.png" alt="Blockheads Patcher logo">
</p>

<h1 align="center">Blockheads Patcher</h1>

<p align="center">
  Fix crashes and add small improvements to <b>The Blockheads</b> on your phone. Works in the browser, on desktop and on Android. 🔧
</p>

<p align="center">
  <img src="https://img.shields.io/maintenance/yes/2026?style=for-the-badge" alt="Maintained">
  <a href="https://github.com/Blockheads-Club/blockheads-patcher/releases"><img src="https://img.shields.io/github/v/release/Blockheads-Club/blockheads-patcher?include_prereleases&style=for-the-badge" alt="Release"></a>
  <a href="https://github.com/Blockheads-Club/blockheads-patcher/actions/workflows/ci.yml"><img src="https://img.shields.io/github/actions/workflow/status/Blockheads-Club/blockheads-patcher/ci.yml?branch=dev&style=for-the-badge&label=CI" alt="CI"></a>
  <a href="LICENSE"><img src="https://img.shields.io/github/license/Blockheads-Club/blockheads-patcher?style=for-the-badge" alt="License"></a>
</p>

---

## 🚀 Project Status
**Current Status:** Alpha (v0.1.1 pre-release). Usable, but test the patched game before you rely on it.

The Patcher takes **your own copy** of The Blockheads for Android and gives you back a fixed copy to install. It fixes
the freeze on the "WELCOME TO ...!" popup when joining a server on Android 10+, several crashes and freezes, and adds
small improvements such as controller support, fullscreen and a tablet layout. You choose which patches to apply.

Everything happens on your device: **no game files are included or downloaded**, and there is no server.

---

## 📦 Other Blockheads Club Repositories
- [**blockheads-pc**](https://github.com/Blockheads-Club/blockheads-pc) - Play The Blockheads on your computer
- [**blockheads-server**](https://github.com/Blockheads-Club/blockheads-server) - Host your own Blockheads server for friends
- [**website**](https://github.com/Blockheads-Club/website) - The [Blockheads Club website](https://blockheads-club.github.io/website/): downloads, guides and docs

---

## ⚡ Trying Blockheads Patcher
- **In the browser:** open [blockheads.club/patcher](https://blockheads.club/patcher/), pick your game APK, choose patches, download the result.
- **On Android:** install the APK for your phone (`android-arm64` for most phones) from the [latest release](https://github.com/Blockheads-Club/blockheads-patcher/releases/latest). It patches the copy already installed on your phone.
- **On desktop:** Windows (`.exe` / `.msi`), macOS (`.dmg`) and Linux (`.AppImage` / `.deb`) from the [latest release](https://github.com/Blockheads-Club/blockheads-patcher/releases/latest).

The patched game is signed with a new key, so Android asks you to uninstall the original first (back up your worlds).
Step by step: [Fix the game on your phone](https://blockheads-club.github.io/website/guides/fix-game-on-phone/), more in the
[docs](https://blockheads-club.github.io/website/docs/).

Extra patches can be imported as `.bhpack` files (Settings -> Imported patch packs). Packs are data only; the Patcher
never runs code from them. Format: [docs/patch-packs.md](docs/patch-packs.md).

---

## 🛠️ Requirements
**To use:** a modern browser, or Windows / macOS / Linux / Android, and your own copy of The Blockheads for Android.

**For contributors / development:** [bun](https://bun.sh) and Rust stable. For the Android app also the Android SDK,
NDK 27 and JDK 17 or 21.

---

## 🤝 Contributing
Everyone can open [issues](https://github.com/Blockheads-Club/blockheads-patcher/issues) and pull requests. Irrelevant
or abusive issues may be closed or removed.

### Development Guide
```bash
git clone https://github.com/Blockheads-Club/blockheads-patcher.git
cd blockheads-patcher
bun install
bun run dev        # web app on http://localhost:1420
bun run test:cov   # the gate: every test, 100% coverage
```

More: [docs/development.md](docs/development.md) (desktop and Android builds, tests, deploy, releases, CI) and
[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) (module contracts).

### Credits
Bug list and ideas from [JarlPenguin/blockheads-android-patches](https://github.com/JarlPenguin/blockheads-android-patches);
every fix was written independently by Blockheads Club from our own analysis of the game
([details](docs/cleanroom/jarlpenguin-triage.md)). Credited patches show this in the app.

---

## 📄 License
Blockheads Patcher is licensed under **GNU GPLv3 or later** (GPL-3.0-or-later). This program is free software: you can redistribute it and/or modify it under the terms of the GNU General Public License as published by the Free Software Foundation, either version 3 of the License, or (at your option) any later version. See the [LICENSE](LICENSE) file for details.
Bundled Noto Sans font subsets are under the SIL Open Font License 1.1.

Unofficial fan project, not affiliated with Majic Jungle Games or Noodlecake Studios. Only patch software you legally
own.
