# Atlarix architecture — Live Code Map & parsers

Technical reference for how Atlarix builds the **Live Code Map** (in-product **Blueprint** graph) and related structural tooling. This is internal architecture documentation—not marketing copy.

## Live Code Map (Blueprint graph)

**Blueprint on demand.** Atlarix builds a Blueprint graph when the agent calls `get_blueprint` or uses structural `search` — not by injecting the whole repo every turn. The model loads focused slices from the graph instead of scanning hundreds of thousands of raw tokens.

| Language / extension | Primary parser | Fallback / merge |
| --- | --- | --- |
| `.ts`, `.tsx`, `.js`, `.jsx` | **oxc-parser** (native, worker pool, 256 KB cap) | Regex for routes / framework handlers |
| `.py` | **tree-sitter WASM** | Regex for Flask/FastAPI/Django routes |
| `.go` | **tree-sitter WASM** | Regex for types and functions |
| `.rs` | **tree-sitter WASM** | Regex for structs and functions |
| Other supported langs | Regex heuristics | — |

### Product surfaces

- **Live View** — Diagram extracted from your codebase (Mermaid). Read-only architecture visualization.
- **Blueprint Mode** — Add containers, beacons, and edges; compare desired vs actual; generate `.atlarix/ATLARIX_PLAN.md`.
- **Incremental Updates** — File watcher updates affected Blueprint nodes automatically.
- **Combined Blueprints** — Polyrepo / monorepo: one view with cross-project edges.
- **`.atlarixignore`** — Gitignore-syntax exclusions from parsing, Blueprint nodes, and prompt injection.

### Parser pipeline (v8.2+)

- **oxc-parser** runs in a dedicated worker pool for TS/JS/JSX/TSX with per-file size caps and cooperative yielding during large parses.
- **tree-sitter WASM** handles Python, Go, and Rust with grammar bundles in `extraResources`.
- Regex heuristics fill gaps (routes, framework handlers) and unsupported languages.

### Tools

- `get_blueprint` — lazy graph fetch; default Markdown summary capped at 300 lines; optional `include_raw`.
- `get_diagram` — Mermaid architecture/flow views on demand.
- `search({ mode: "structural" })` — graph-backed code discovery.
- `commit_blueprint` — Workforce tier; writes `.atlarix/blueprint.json` with approval.

See [CHANGELOG.md](CHANGELOG.md) for release-specific parser and packaging notes.
