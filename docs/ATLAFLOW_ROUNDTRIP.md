# Atlaflow Round-Trip: Project ↔ Atlaflow ↔ Diagram

This doc describes how existing projects and the new Atlaflow system stay in sync with the diagram.

---

## Goals

1. **Project → Atlaflow + diagram** – Existing project becomes an editable workflow on the canvas and (optionally) a Mermaid diagram.
2. **Atlaflow → project + diagram** – Designing in Atlaflow produces or updates project code and diagram.
3. **Modify Atlaflow → change in project + new/modified diagram** – Editing the canvas triggers code changes and diagram updates.

---

## Pipeline Overview

```
┌─────────────┐     extractors      ┌─────────┐    appMapToAtlaflow    ┌──────────────┐
│   Project   │ ──────────────────► │ AppMap  │ ─────────────────────► │   Atlaflow   │
│  (any lang) │                     │ (spec)  │                         │ (nodes+conn) │
└─────────────┘                     └────┬────┘                         └──────┬───────┘
       ▲                                 │                                     │
       │                                 │ atlaflowToAppMap                     │
       │ codegen                         │                                     │
       │ (per language)                  ▼                                     │
       │                          ┌─────────────┐                             │
       └──────────────────────────│   Atlaflow   │ ◄───────────────────────────┘
                                  │  (canvas)   │     user edits
                                  └──────┬──────┘
                                         │
                                         │ Apply / Generate Code
                                         ▼
                                  ┌─────────────┐     Mermaid from
                                  │   Diagram    │ ◄── spec or AI
                                  │  (Mermaid)   │
                                  └─────────────┘
```

- **AppMap** = language-agnostic spec (entry points, data sources, screens, flows). Same shape for every language.
- **Atlaflow** = n8n-style JSON (nodes + connections) used in the canvas. Can be derived from AppMap or edited by hand.
- **Diagram** = Mermaid architecture diagram. Can be generated from AppMap/spec or by AI.

---

## 1. Project → Atlaflow + diagram

**Flow:** Project → **extractors** (per language) → AppMap → **appMapToAtlaflow** → Atlaflow workflow → save in diagram metadata. Diagram = existing Mermaid or generate from AppMap.

**Steps:**

1. **Extract AppMap from project** (per language/framework):
   - Backend: routes/handlers → `entryPoints`, DB/APIs/queues → `dataSources`, optional `flows`.
   - Frontend (optional): routes/pages → `screens`.
   - Implement one extractor per language Atlarix supports (Node, Python, Go, Rust, Ruby, Java, PHP, .NET, Elixir, Deno, Bun).
2. **Convert AppMap → Atlaflow:** `appMapToAtlaflow(appMap)` produces nodes (entry points, data sources, screens) and connections from `flows`. Node types: `atlaflow.entryPoint`, `atlaflow.dataSource`, `atlaflow.screen`.
3. **Persist:** Save the resulting workflow in `diagram.metadata.workflow` (and optional `diagram.metadata.appMap` for round-trip).
4. **Diagram:** Keep existing Mermaid from AI, or generate a simple Mermaid from AppMap (boxes for entry points/data/screens, edges from flows).

**Current state:** Extractors are not yet implemented. Today we use `inferWorkflowFromProject` (best-effort from package.json + workspace analyzer). To support round-trip, add extractors that output `AppMap` and then call `appMapToAtlaflow(appMap)` so existing projects populate the canvas with entry points and data sources.

---

## 2. Atlaflow → project + diagram

**Flow:** User designs in Atlaflow (or imports JSON) → **atlaflowToAppMap** → AppMap → **codegen** (per language) → write/update project files. Diagram = regenerate from AppMap or AI with new spec.

**Steps:**

1. **Atlaflow → AppMap:** `atlaflowToAppMap(workflow, runtime)` parses canvas nodes (entry points, data sources, screens, n8n-style nodes) and connections into AppMap.
2. **Codegen:** From AppMap, generate or update code (one codegen path per language): e.g. add route, add DB connection, add screen. Use templates and file writes.
3. **Diagram:** Regenerate Mermaid (e.g. from AppMap or by calling AI with “here is the new structure: …”).

**Current state:** `atlaflowToAppMap` exists. Codegen from AppMap is not yet implemented; “Generate Code” currently copies workflow JSON to chat. Next step: implement codegen from AppMap for at least one language (e.g. Node/Express).

---

## 3. Modify Atlaflow → change in project + new/modified diagram

**Flow:** Same as “Atlaflow → project + diagram”. User edits canvas (add/remove nodes, connections, per-node messages) → **Apply** or **Generate Code** → `atlaflowToAppMap` → codegen → update project → regenerate diagram.

**Steps:**

1. User edits Atlaflow (add endpoint, add data source, change connections).
2. On “Apply” / “Generate Code”: run `atlaflowToAppMap(currentWorkflow, runtime)`.
3. Compute **diff** vs last known AppMap (or vs current project): what entry points/data/screens were added, removed, or changed.
4. Codegen only the **delta** (new file, update route, etc.) to avoid overwriting unrelated code.
5. Update diagram: regenerate Mermaid from new AppMap or trigger AI diagram refresh.

**Current state:** No diff yet; would be “full AppMap → codegen” or “delta AppMap → codegen”. Diagram refresh is manual (user clicks Regenerate) or could be triggered after codegen.

---

## Files and Types

| File | Purpose |
|------|---------|
| `app_map_types.ts` | `AppMap`, `AppMapEntryPoint`, `AppMapDataSource`, `AppMapFlow`, `AppMapScreen`, `Runtime` |
| `app_map_to_atlaflow.ts` | `appMapToAtlaflow(appMap)` → AtlaflowWorkflow (project → canvas) |
| `atlaflow_to_app_map.ts` | `atlaflowToAppMap(workflow, runtime)` → AppMap (canvas → codegen) |
| `project_to_workflow.ts` | Current best-effort: project → InferredWorkflow (no AppMap yet) |
| `workflow_loader.ts` | Loads workflow from diagram metadata or infers via `inferWorkflowFromProject` |

**Extractors (to add):** e.g. `extractors/node.ts`, `extractors/python.ts`, … → each returns `AppMap` from a project path.

**Codegen (to add):** e.g. `codegen/node.ts`, `codegen/python.ts`, … → each takes `AppMap` (or delta) and project path and writes/updates files.

---

## Summary

- **Project → Atlaflow + diagram:** Extractors → AppMap → `appMapToAtlaflow` → save workflow (+ optional diagram from AppMap).
- **Atlaflow → project + diagram:** `atlaflowToAppMap` → AppMap → codegen → project files; regenerate diagram from AppMap or AI.
- **Modify Atlaflow → project + diagram:** Same as above; optionally diff AppMap and codegen only changes, then refresh diagram.

Implementing extractors (project → AppMap) and codegen (AppMap → project) per language will complete the round-trip; the types and converters above are the shared pipeline.
