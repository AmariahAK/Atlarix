# Atlaflow Vision: Diagram Workflow = Your Project

This doc captures the product vision for Atlaflow: **the workflow on screen is the project** — same level of detail as n8n/Zapier, but for codebases. No need to “remember code”; change the workflow (or send notes) or prompt, and the project + diagram stay in sync.

---

## Target: n8n-Level Detail

**Reference:** n8n-style workflows where:

- **Backend:** Triggers (webhook, form submission, schedule) → steps (Create user in Google Workspace, Is Manager? → Jira Admin/Member, Create Slack user → Update Slack profile). Clear nodes for APIs, conditionals, branching, parallel paths.
- **Frontend / API:** Trigger (Run weekly) → Get Facebook/Twitter/LinkedIn analytics → Format metrics → Merge → Write to sheet, Send report. Nodes show integrations, data sources, transformations.
- **Webhook + internals:** Webhook → AI Agent (Chat Model, Memory, Tools) → Respond to Webhook. Sub-nodes for model, memory, tools.

**For Atlaflow we want the same granularity for existing projects:**

- **Python (e.g. TensorFlow/PyTorch):** Training data source, model training step, API endpoints, webhooks, inference pipeline — each as nodes. User sees “where is the data,” “how does the API act,” “what triggers what.”
- **Frontend:** Pages, API calls, data sources, auth flows — as nodes.
- **Backend:** Routes/handlers, DB, queues, external APIs, webhooks — as nodes.

So: **one (or two) workflows on screen that map the real project** — not a single “Python App” box, but a graph of triggers, steps, data sources, and integrations.

---

## Polyproject & Monorepo

- **Two repos in one workspace (polyproject):** Show both backend and frontend — either **two workflows on the same screen** (e.g. left: backend, right: frontend) or **one large workflow** with clear visual grouping (backend cluster, frontend cluster). Languages and APIs labeled.
- **Monorepo:** One workflow, but **differentiated** — what’s frontend, what’s backend, which languages, which APIs. Grouped so users can see “what is where” and modify it.

---

## Interaction Model

1. **Diagram workflow = your project**  
   The canvas is the canonical view: what you see is what the project does (or what you’ve specified). You don’t have to “remember code” — the idea lives in the workflow.

2. **Change by workflow or by prompt**  
   - **Workflow:** Add/remove nodes, change connections, add per-node notes. Apply → codegen updates the project; diagram updates.  
   - **Prompt:** User describes a change in chat; AI edits code. After the edit, **re-run extractors** (or incremental update) so the **workflow on screen updates** to reflect the new code. So “after the change we see the workflow change.”

3. **No separate “save workflow”**  
   - **Current version on screen:** Either derived from project (extractors → AppMap → Atlaflow) or the user’s edited spec (to be applied via codegen).  
   - **Persistence:** We keep saving **pre & current diagrams** (Mermaid + metadata) as today. The “workflow” in diagram metadata can be the last extracted or last applied spec, so we can restore or diff.

4. **Live sync**  
   - **Edit workflow → project:** Atlaflow → AppMap → codegen → update files → optionally refresh diagram.  
   - **Prompt → project → workflow:** User prompts → AI changes code → extractors run (on save or on demand) → workflow view updates so “we see the workflow change as it changes the diagram.”

---

## Why the Canvas Is Empty Today

Right now you see **language/node-type list** (Python App, FastAPI, Go, Rust, Java App, …) in the palette but **no detailed workflow on the canvas** for an existing project because:

- **Extractors** (project → AppMap with triggers, steps, data sources, APIs) are **not implemented yet**. So we don’t yet turn “this TensorFlow backend” or “this Next frontend” into n8n-style nodes.
- **Current path:** We use `inferWorkflowFromProject` (best-effort from package.json + workspace analyzer), which often yields one high-level node (e.g. “Python App”) or a few modules — not the fine-grained “webhook → API → DB → Slack” level.

**To reach the vision:**

1. **Extractors (per language/framework)** that output an **AppMap** (or extended spec) with:
   - **Triggers:** webhooks, schedules, form submissions, CLI entry points.
   - **Steps:** API calls, “create user in X,” “format metrics,” “merge,” “write to sheet.”
   - **Data sources:** training data, DBs, caches, queues, external APIs.
   - **Conditionals/branching** where detectable (e.g. “if manager → Jira Admin else Jira Member”).
2. **AppMap → Atlaflow** (already in place) to turn that spec into **nodes + connections** so the canvas shows the n8n-level graph.
3. **Polyproject:** When workspace has multiple roots or detected frontend+backend, run extractors per part and either:
   - Render **two workflows** on the same screen, or  
   - Merge into **one workflow** with clear groups (frontend / backend / languages / APIs).
4. **Live sync:** On file save (or “Refresh workflow”), re-run extractors and update the canvas; on “Apply” from canvas, run codegen and update diagram. No separate “save workflow” — current view is either derived or the spec to apply; we persist diagram versions (pre/current) as now.

---

## Summary

- **Yes, this is possible.** The architecture (AppMap, extractors, Atlaflow round-trip, diagram versioning) is the right path.
- **Goal:** “Diagram workflow = your project” — n8n-level detail (triggers, APIs, data, steps, conditionals), polyproject support (two workflows or one differentiated), change by workflow or by prompt, workflow view updates when code changes, no separate workflow save — only diagram versions (pre/current).
- **Gap:** Rich **extractors** (and optional extended AppMap for conditionals/branching) so existing projects populate the canvas with the same level of detail as the n8n examples. Once that exists, the rest (two workflows on one screen, live sync, codegen from edits) builds on the current round-trip design.
