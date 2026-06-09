# Atlarix v12.9.6 — Discord technical post

> Paste-ready for the announcements channel. Hotfix for the v12.9.5 Terminal fix.

---

**Atlarix v12.9.6 released** 🖥️

Release notes (technical):

- **The Terminal actually opens now.** v12.9.5 tried to fix "Interactive shell unavailable: posix_spawnp failed" by adding node-pty's `spawn-helper` to an `asarUnpack` array — but `asarUnpack` is an **electron-builder** option, and this app is built with **electron-forge/electron-packager**, which silently ignores it. (Confirmed against the shipped 12.9.5 build: `spawn-helper` was still trapped inside `app.asar`, so node-pty's `posix_spawnp` of `app.asar.unpacked/.../spawn-helper` hit ENOENT.) The correct electron-packager key is `packagerConfig.asar.unpack` (a minimatch glob, which `AutoUnpackNativesPlugin` merges with `**/*.node`). Switched to it so the `@lydell/node-pty-<platform>` dirs — `spawn-helper` (macOS) and the conpty/winpty binaries (Windows) — are unpacked to disk and code-signed. Verified with a local package build that `spawn-helper` lands in `app.asar.unpacked`. No app-code change.

Downloads: **atlarix.dev**. Full changelog: `docs/CHANGELOG.md`.
