# Blueprint UX Plan

> Use **icons/symbols** for feature types in the UI (e.g. plug icon for API, hook icon for Webhook, lightning for Function, component/paint icon for Feature). The plan below describes the behavior; implementation uses the existing icon set (e.g. Lucide) on the features.

---

## Current Problem Analysis

- Everything labeled "feature" (no differentiation).
- Can't connect API/Webhook/Function within a component.
- Just text blobs (not interactive).
- No visual flow inside a component.
- No credential management.

**Conclusion:** This is not good UX.

---

## Two Possible Solutions

### Option 1: Nested Flow (n8n-style Inside Components)

**User flow:**

1. Click a component (e.g. "src").
2. Opens detailed view (like entering a page).
3. See mini-workflow inside:

```
┌─────────────────────────────┐
│ Inside "src" Component      │
│                             │
│ [Webhook] → [API] → [Function] → [Feature]
│                             │
│ Click API → Configure:      │
│ • Provider: OpenRouter      │
│ • Key: OPENROUTER_API_KEY   │
│ • Model: minimax-2.1        │
└─────────────────────────────┘
```

**Pros:** Visual flow, interactive (drag, connect, configure), familiar (n8n-like).

**Cons:** Complex to build (nested canvas), can feel disconnected from outer view, harder to see big picture.

---

### Option 2: Smart Labels + Inline Config (Simpler)

**User flow:**

1. Click a component.
2. See list view (current structure).
3. Items are **labeled by type** and **configurable**:

```
┌─────────────────────────────────┐
│ [API icon] API: OpenRouter      │
│   └─ Key: OPENROUTER_API_KEY    │
│   └─ Model: minimax-2.1         │
│                                 │
│ [Webhook icon] Webhook: Resend  │
│   └─ Key: RESEND_API_KEY        │
│   └─ Trigger: user.signup       │
│                                 │
│ [Function icon] processPayment  │
│   └─ Calls: Stripe API           │
│   └─ Returns: transaction ID    │
│                                 │
│ [Feature icon] RecipeCard       │
│   └─ Props: title, image        │
└─────────────────────────────────┘
```

**Pros:** Simple, all info visible, easy to scan, AI can generate labels from code.

**Cons:** No visual connections between items; list can get long for complex components.

---

## Recommended Direction: Hybrid Approach

Combine both: **default to labeled list + inline config**, with an optional **Flow view** toggle.

---

### Default: List View (Quick Scan)

- Toggle: **[List] | [Flow]**.
- Each row is one “function” (API / Webhook / Function / Feature) with:
  - **Type icon + label** (e.g. API icon + "OpenRouter (minimax-2.1)").
  - **Credential** line (e.g. Key: OPENROUTER_API_KEY) with [Edit] / [Test connection] where relevant.
  - **Type-specific config** (trigger, props, calls, returns) and actions (View code, Edit, View logs, etc.).

Example structure:

```
┌─ src Component ────────────────────────────┐
│ [List] [Flow]                                 │
│ ─────────────────────────────────────────────│
│ [API icon] API                                │
│ ├─ OpenRouter (minimax-2.1)                  │
│ └─ Key: OPENROUTER_API_KEY                   │
│    [Edit] [Test Connection]                  │
│ [Webhook icon] Webhook                        │
│ ├─ Resend Email Sender                       │
│ └─ Key: RESEND_API_KEY                       │
│    Trigger: POST /api/send-email             │
│    [Edit] [View Logs]                        │
│ [Function icon] Function                      │
│ ├─ processPayment()                          │
│ └─ Calls: Stripe API, Database               │
│    [View Code] [Edit]                        │
│ [Feature icon] Feature                        │
│ ├─ RecipeCard Component                      │
│ └─ Props: title, image, rating               │
│    [View Code] [Preview]                     │
└──────────────────────────────────────────────┘
```

(All four types use their **icons/symbols** in the UI, not emojis.)

---

### Flow View: Visual Connections

- Same header: **[List] | [Flow]**.
- Canvas shows nodes by type (with same icons): Webhook → Function → API → Feature, with edges.
- Clicking a node opens the same inline config (or a side panel) so behavior stays consistent with the list.

---

### Credentials Tab (Toolbar Key Icon)

- **Creds** (or “Credentials”) tab in the toolbar (key icon).
- Shows project credentials (backed by .env; not committed).
- List of key/value rows (value masked), with add/edit/remove.
- “Add to .env” adds/updates the key in the project’s .env.
- In Blueprint, function rows that use a key can link to this (e.g. “Key: OPENROUTER_API_KEY” → link to Creds tab or “Edit in .env”).

---

### Implementation Outline

1. **Smart type detection & labeling**  
   Classify each function as API / Webhook / Function / Feature from name + code; extract provider, credential env key, trigger, props, calls, returns. Use this to drive both list and flow.

2. **Enhanced function list UI**  
   One row per function with type icon, label, expandable config (provider, credential, trigger, etc.) and actions (View code, Edit, Test connection, View logs). No emojis; use icons/symbols for the four types.

3. **Optional flow view**  
   Mini canvas inside the component: nodes = same functions, edges = inferred or user-defined “calls/triggers”. Click node → same config as in list (single source of truth).

4. **Credentials panel**  
   Key icon in toolbar → Creds tab: list .env keys, add/edit (write to .env), optional “used by” linking to Blueprint functions.

---

## Summary

- **Default:** Smart list with type icons, inline config, and credential hints.
- **Optional:** Flow view for visual connections inside a component.
- **Creds tab:** Manage .env from the UI and reference from Blueprint.
- **AI:** Generates labels and structure from code; users configure and connect; AI does the actual code generation.

---

# Recommendation (Agent)

Below is a concise plan that builds on your idea and keeps implementation realistic.

---

## 1. Agree: Hybrid is the right default

- **Primary surface:** List view with **clear type differentiation** (icons/symbols for API, Webhook, Function, Feature), **inline config** (provider, env key, trigger, props, etc.), and **actions** (View code, Edit, Test, View logs). No emojis in the plan or in feature labels; use a consistent icon set (e.g. Lucide) for the four types.
- **Secondary surface:** Optional **Flow view** inside a component (same nodes, edges for “calls/triggers”) so power users can see and later edit connections without rebuilding the whole UI as n8n.

So: “when we click inside a component, we enter a page” = **room detail** with List | Flow and the same config model.

---

## 2. “Connect them” without full n8n

- **Connections** can be **semantic first**, **visual second**:
  - **Infer from code:** “this webhook calls this function; this function uses this API.” Show in list as “Calls: X, Y” and in Flow as edges.
  - **Allow overrides:** In Flow view, user can add/remove edges (“A triggers B”). That stores a small “flow” or “call graph” overlay (per room) that the AI respects when generating code.
- So: we don’t need a full n8n canvas day one. We need:
  - List with types + config (and icons).
  - Optional Flow where nodes are the same functions and edges are “calls / triggers” (stored as data; AI does the code).

---

## 3. Credentials: one place, referenced everywhere

- **Creds tab (key icon)** = single place for project secrets (backed by .env).
- In Blueprint, every API/Webhook (and optionally Function) that uses a key shows **which env key** it uses (e.g. OPENROUTER_API_KEY) and a link to “Edit in Creds” or open the Creds tab.
- So: “Key in .env called OPENROUTER_API_KEY” and “Webhook for Resend, creds in .env RESEND_API_KEY” are **labels + references** from Blueprint to the Creds tab; Creds tab is where values are edited. No duplication.

---

## 4. Phasing that matches “is this good UX?”

- **Phase A (quick win):**  
  - Differentiate types in the list: **icon + label per type** (API, Webhook, Function, Feature).  
  - Add **expandable config** per row (provider, credential key, trigger, props, etc.) from analysis.  
  - Use **one icon set** (e.g. Lucide) for the four types everywhere (plan + UI).

- **Phase B:**  
  - **Creds tab** (key icon): list .env keys, add/edit, mask values.  
  - In Blueprint list, show “Key: X” and link to Creds.

- **Phase C:**  
  - **Flow view** inside a room: same nodes as list, edges from inferred (and later user-editable) “calls/triggers.”  
  - Click node → same config as list (single source of truth).

- **Phase D (optional):**  
  - User-editable edges in Flow (e.g. “Webhook A triggers Function B”) and persist so AI can “connect them” in generated code.

---

## 5. Direct answers

- **“Is this good UX?”**  
  The **hybrid (list + optional flow + creds)** is good UX: scanable list, optional visual flow, one place for secrets, AI does the code.

- **“Connect them / make sure they work”**  
  Start with **inferred** connections (from code) shown in list and in Flow; later let users add/remove edges in Flow and persist so the AI can generate code that “connects” correctly.

- **“Inside flowchart of the inside flowchart”**  
  That’s the **room detail** view with **List | Flow**: list = linear detail, Flow = same functions as nodes with edges. One data model, two views.

- **“Text it vs n8n-style”**  
  Prefer **text + structured config** (e.g. “API: OpenRouter, Key: OPENROUTER_API_KEY, Model: minimax-2.1”) as the source of truth; Flow is a **view** on that. So we “text it” in list/config and **visualize** it in Flow, instead of building a full n8n editor first.

- **Icons vs emojis**  
  In the **plan** and in **feature labels**, use **icons/symbols** (e.g. plug for API, hook for Webhook, lightning for Function, component for Feature) from your icon set; keep the current code and only standardize on that icon set for the four types.

---

## 6. One-line pitch

**Blueprint room = one page:** list of functions with type icons and inline config, optional flow view of the same functions and their connections, creds in one tab and referenced by key name everywhere—AI does the code; we configure and connect in the UI.

This document is the single plan: emojis replaced by icon/symbol references for features, and the above recommendation applied consistently.
