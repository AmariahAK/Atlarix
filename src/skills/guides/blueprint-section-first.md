# Blueprint — section-first (`get_blueprint` only)

Section scoping applies to **`get_blueprint`** and the blueprint parse layer (performance on large repos). Other tools (`grep`, `glob`) work as before — use optional `path` when you want to narrow results.

## Recommended workflow (architecture)

1. **Pick a section:** `glob({ pattern: "*", path: "." })` — choose one top-level folder (e.g. `packages/api`).
2. **Explore as needed:** `glob`, `grep`, `read_file` — optional `path` to limit scope.
3. **Structure:** `get_blueprint({ focus_path: "<section>" })` — defaults to the whole section (`scope: "full"`). Optional: `path: "src"` to drill into a subfolder; `topic` to filter rooms.
4. **Optional:** `get_blueprint` with a `topic` filter narrows the slice to matching rooms.

## Rules (blueprint only)

- `get_blueprint` **requires** `focus_path` — an **existing** workspace-relative folder name (exact spelling; case-sensitive on Linux).
- If the tool returns `success: false` with `suggestions`, retry with one of the suggested paths (e.g. typo `airtable2newpostgress` → `airtable2newpostgres`).
- Check `parseQuality` on success (`rich` / `moderate` / `thin`). **Thin success is not failure** — the graph is still usable; drill with `path` or `topic` if needed.
- `success: false` with **Section not found** is a path mistake — fix `focus_path`, do not fall back to a manual `glob` tour unless the user wants one.
- Use `fallback_tools` only on **parse timeout** or other failures after a **valid** `focus_path` — do **not** replace a successful thin blueprint with a manual listing unless the user asks for more detail.
- On blueprint timeout/failure: use `fallback_tools` from the error — do **not** retry workspace-root `get_blueprint`.
- For full-repo architecture in Workforce, use explicit IPC refresh / `allow_workspace_root` (not default tool path).

## Packaged app (downloaded Atlarix)

Python/Go structural edges load grammars from the install bundle (`Resources/ast-grep-grammars` + unpacked natives). If `get_blueprint` fails with native-binding or missing-grammar errors in a **packaged** build, suggest reinstalling from [atlarix.dev](https://atlarix.dev) or running the maintainer check `npm run package:verify` after a local package — do not assume dev `node_modules` paths exist on the user's machine.
