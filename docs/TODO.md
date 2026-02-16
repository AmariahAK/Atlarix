# Atlarix TODO

**Current Version:** v2.9.0  
**Next Version:** v2.10+ (PIVOT full implementation)  
**Last Updated:** 2026-02-16

---

## Next session (to be done)

- **Diagram: file-tree layout**
  - Replace grid/ELK with a **hierarchical file-tree style** so users see what is connected to what and how data flows.
  - **Beacons:** Horizontal tree for main beacons (e.g. DB ←→ API); under each main beacon, a **vertical file tree** for sub-beacons (e.g. User Profile with children Edit, Delete; Signup/Login with OAuth, Manual). Layout should reflect real structure (main beacons with sub-beacons underneath doing tasks).
  - **Containers:** Same file-tree idea for the container canvas (no sub-containers); main containers in a horizontal or vertical tree so connections and hierarchy are clear.
- **Optional:** Ensure edge labels or tooltips show what data is sent where when supported by the model.

---

## Done: v2.7 — AWS Bedrock and changelog order (released 2026-02-14)

- **AWS Bedrock:** Added to Settings → AI → AI Providers (cloud list); token budget supported.
- **Changelog order:** Newest releases now appear at the top.

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

## v2.5 — PIVOT (released 2026-02-14)

**Tagline:** From Code to Canvas, Canvas to Code — Architecture Made Simple

**Done in v2.5:** Right panel simplified (Activity removed, Vault kept); Thinking + agent delegation combined in chat; Auto model selection by mode/role (Direct/Guided → Balanced main, agents Fast; Autonomous → Thinking main, agents Balanced, subagents Fast); agent-phase animations on Blueprint canvas (Architect/Builder/Reviewer); PIVOT foundation (`src/lib/pivot/` types, SQLite schema, placeholders); atlarix-releases repo content (README, SECURITY, LICENSE).

---

## Done: v2.6 — Containers & Beacons UX and docs (released 2026-02-14)

- **Ephemeral session fix;** permission sounds on approval batches.
- **Docs:** AGENTS.md, AGENTS_COMPACT.md, agent-tools for delegate_to_agent and Blueprint (get_blueprint, compare_blueprint_to_live, add_blueprint_room/function/edge, update_blueprint).
- **chat:activity** for native tool start/end; Containers & Beacons UI rename (Diagram/Blueprint).
- **Blueprint UX:** Delete container/beacon, drag nodes, Summary Card, Edit Internals, Back, onboarding, "Always show beacons", AI-generated badge, Flow zoom/pan; aiGenerated in add_blueprint_function/update_blueprint.
- **Capability comparison** in README.

**Remaining for full PIVOT:**
- **Stage 1 — ANTLR4 parsing:** TS/JS, Python, Java, Go, C/C++, Rust; ASTs from language grammars.
- **Stage 2 — Structure extraction:** Nodes and edges; framework detection (Express, Next.js, FastAPI, etc.).
- **Stage 3 — SQLite persistence:** Wire schema to extractors and blueprint snapshots.
- **Stage 4 — Clustering & visualization:** AI clustering into 5–8 containers; beacon descriptions; canvas output.
- **Stage 5 — Analysis layer:** SonarQube, Semgrep, SCIP, traces.
- **UI levels:** Canvas (containers) → Container view (beacons) → Beacon editor (prompt + connections). Live vs Blueprint comparison, Generate Code workflow, undo/history.
