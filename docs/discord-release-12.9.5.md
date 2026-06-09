# Atlarix v12.9.5 — Discord technical post

> Paste-ready for the announcements channel. Hotfix follow-up to v12.9.

---

**Atlarix v12.9.5 released** 🖥️

Release notes (technical):

- **The Terminal now opens in the installed app.** After v12.9 stopped the Terminal from crashing the app, the packaged build couldn't actually launch a shell — it showed "Interactive shell unavailable: posix_spawnp failed". node-pty's macOS `spawn-helper` is a separate Mach-O executable (a sibling of `pty.node`, **not** a `.node` file), so `AutoUnpackNatives` — which only unpacks `*.node` — left it inside `app.asar`. node-pty resolves the helper to `app.asar.unpacked/.../spawn-helper` and `exec`s it; since that path didn't exist, `posix_spawnp` failed with ENOENT (you can't exec a file inside an asar archive). Fixed by `asarUnpack`-ing the `@lydell/node-pty-<platform>` dirs (the same packaging pattern already used for the `@ast-grep` native packages), so `spawn-helper` (and the Windows conpty/winpty binaries) ship on the real filesystem and get code-signed. No app-code change — the spawn path already degraded gracefully; this was purely a packaging gap. Dev was unaffected.

Downloads: **atlarix.dev**. Full changelog: `docs/CHANGELOG.md`.
