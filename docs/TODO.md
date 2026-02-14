# Atlarix TODO

**Current Version:** v2.2.0  
**Next Version:** v2.5.0 — PIVOT (From Code to Canvas, Canvas to Code)  
**Last Updated:** 2026-02-12

---

## Done: v2.1 — Agent System and Project Understanding

- **Schema and settings:** Agent mode, permission mode (Ask/Build), Auto, three favorites per provider, AI Configuration options.
- **Project instructions:** Load/save `.atlarix/ATLARIX.md` and `~/.atlarix/ATLARIX.md`; precedence in system prompt; context window from resolved model.
- **Summarization model:** Fast/same/custom for compaction and title generation.
- **Built-in agents and delegate_to_agent:** Research, Architect, Builder, Reviewer; Guided flat delegation; Autonomous nested with depth limit.
- **Chat UI:** Mode (Direct/Guided/Autonomous) + Permission (Ask/Build); Auto toggle; active context bar.
- **Activity Stream:** Right-panel tab; events for delegation, compaction, self-review, turn summary.
- **Self-review:** Runtime stub (Activity Stream); settings schema in place.
- **Autonomous mode:** Nested delegation with max depth; shared context and approval modal can be extended later.
- **Agent Lightning:** Trace collection to `.atlarix/training_data/`; training entry point (placeholder).
- **Token budget:** Turn summary in Activity Stream; per-provider budget in schema.

---

## Done: v2.2 — Blueprint Intelligence (RTE + RAG + Combined Blueprints)

- **RTE parsers:** TypeScript and Python parsers; parser types and registry; single-project Blueprint from RTE.
- **Blueprint cache:** `~/.atlarix/blueprints/{projectHash}/`; manifest, blueprint.json; load/save and staleness.
- **Combined blueprints:** CombinedBlueprint schema, project-selector (findProjects), combined-generator (generateCombinedBlueprint, detectCrossProjectEdges); cache persistence for single and combined.
- **AI-selected blueprinting:** Activity scoring; "Generate Blueprints" modal with project list and recommendations; AI prompt for blueprint/diagram selection.
- **RAG:** queryBlueprint, getCodeForNodes; chat integration; file watcher for incremental Blueprint updates.
- **Parent-aggregated permissions:** batch_plan in PermissionInterceptor and schema; single approval modal; execute all on approve.
- **Motia-style UI:** React Flow canvas; node types and colors; Blueprint-driven ATLARIX_PLAN flow.
- All six implementation phases completed.

---

## v2.2 — Done (see Done section above)

---

## v2.5 — PIVOT (planned)

**Tagline:** From Code to Canvas, Canvas to Code — Architecture Made Simple

**Core:** Three-state system: Live Diagram (current code) ↔ Blueprint (desired state) → Generated Code. **Containers** = high-level architectural components (e.g. Auth API, Payment Service). **Beacons** = individual functionality inside a container (e.g. Login, Signup, Send Email).

**Pivot Engine (high level):**
- **Stage 1 — ANTLR4 parsing:** TS/JS, Python, Java, Go, C/C++, Rust; ASTs from language grammars.
- **Stage 2 — Structure extraction:** Nodes (functions, classes, APIs, DB, webhooks) and edges (calls, imports, inherits); framework detection (Express, Next.js, FastAPI, etc.).
- **Stage 3 — SQLite graph storage:** nodes, edges, containers, beacons, container_nodes, container_edges, beacon_edges, blueprint_snapshots, analysis_issues, runtime_traces; recursive CTEs for traversal.
- **Stage 4 — Clustering & visualization:** AI clustering of nodes into 5–8 containers; beacon description generation; canvas structure output.
- **Stage 5 — Analysis layer:** SonarQube (quality), Semgrep (security), SCIP (code intelligence), Jaeger/Zipkin (runtime traces).

**UI levels:** Canvas (Level 1: containers) → Container view (Level 2: beacons) → Beacon editor (Level 3: prompt + connections). Comparison view (Live vs Blueprint), Generate Code workflow (task breakdown → apply changes), undo/history, onboarding and sample project.

**Roadmap (reference only):** Phase 1 Foundation (Weeks 1–4), Phase 2 Clustering & Analysis (Weeks 5–8), Phase 3 Blueprint Editing (Weeks 9–12), Phase 4 Polish & Testing (Weeks 13–16). Full specification in PIVOT spec; implementation to follow in next session.

**v2.5 (planned) structure:** Implementation will follow the PIVOT spec (e.g. `src/lib/pivot/`, ANTLR4 grammars, SQLite schema from spec). No implementation tasks listed here until work begins.
