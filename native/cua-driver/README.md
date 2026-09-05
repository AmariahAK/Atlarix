# cua-driver (vendored by pin, not by source)

The background computer-use backend for `computer_inspect` / `computer`. Upstream is
[trycua/cua](https://github.com/trycua/cua), MIT, and the crate lives at `libs/cua-driver/rust/`
inside that monorepo.

**No third-party source lives in this repo.** `PIN.json` names an exact rev and CI builds the binary
from it:

```bash
cargo install --locked --git <repo> --rev <rev> cua-driver \
  --target <triple> --root native/.dist/cua-driver
```

`LICENSE` is upstream's, retained because MIT requires it.

## Why a pinned `cargo install` and not the alternatives

- **Submodule** — clones an entire multi-language monorepo for one crate, and needs
  `submodules: recursive` on four checkouts across two workflows. A checkout that forgets it yields
  an *empty directory*, which is a new silent-skip surface. That is the exact failure mode
  `check-sandbox-helpers.mjs` exists to prevent.
- **Vendored source** — tens of thousands of lines of third-party Rust, hand-synced. This repo's own
  doctrine argues against it: `native/atlarix-sandbox-linux/Cargo.toml` records deleting 60% of a
  crate because it was "never compiled by CI, never consumed by the app". Hand-syncing is also how
  you ship a stale private-SPI implementation six months after Apple changes it.
- **Prebuilt download at build time** — rejected twice over. `forge.config.ts` already states the
  doctrine for the models snapshot: "deliberately not fetched at build time so packaging never
  depends on models.dev being reachable." And a downloaded binary would receive our Developer ID
  signature, our notarization, and our TCC grants without a line of it ever being read.

## Two gotchas that will otherwise ship broken, silently

`cargo install --git` honours **neither** the package's `.cargo/config.toml` (cargo discovers config
from the CWD upward, not from the package) **nor** its `rust-toolchain.toml`. Both were confirmed
observationally on 2026-09-04. So the build scripts must set them:

- **macOS:** `MACOSX_DEPLOYMENT_TARGET=13.0`
- **Windows:** `RUSTFLAGS=-C target-feature=+crt-static` — without this the shipped
  `cua-driver.exe` needs the VC++ redistributable, and it will start fine on every CI runner and
  every dev box, failing only for users.
- **Toolchain:** pin `1.97.1` in CI. It also builds clean on 1.93.1, so the pin is belt-and-braces
  rather than load-bearing — but an MSRV-forward crate compiled by a much newer stable is a coin
  flip, so pin it anyway and keep `PIN.json` in sync.

`--locked` emits `package 'chacha20 v0.10.1' in Cargo.lock is yanked … consider running without
--locked`. **Keep `--locked`** — reproducibility is the entire point. Do not "fix" the warning by
dropping the flag.

## Bumping the pin

1. Pick the new rev, update `PIN.json` (`rev`, `version`, `toolchain` if upstream moved it).
2. Re-run `npm run check:cua-pin`.
3. Re-verify, because these are the things a bump can break:
   - `cua-driver list-tools` still exposes the tools our capability manifest allowlists (a removed
     tool becomes a silent capability loss).
   - `call check_permissions` still reports `attribution: "host"` under `serve --embedded`. If that
     ever changes, macOS TCC grants stop following Atlarix's identity and the whole design shifts.
   - `doctor --json` still carries the fields the preflight reads.
   - Telemetry is still opt-out-able via `~/.cua-driver/config.json`.
4. Re-run the notarization dry run if the macOS binary's linkage could have changed.

## Things in this binary that must NEVER be invoked

- `update --apply` — downloads and installs a release over itself. Inside a signed `.app` that breaks
  the code signature and the notarization.
- `skills install` — symlinks a skill pack into other agents' directories (Claude Code, Codex,
  OpenClaw, OpenCode).

Neither is reachable as an MCP *tool*, so a model cannot call them; the hazard is a well-meaning
"check for updates" button wired to the CLI. Don't.
