/**
 * Driver schemas as a tool RESULT, which is the whole reason `computer_call` costs
 * ~200 tokens a turn instead of ~6,000.
 *
 * # The prompt-cache argument, which is the real one
 *
 * Registering all 56 driver tools would add roughly 6,000 tokens to the tools array.
 * That is bad; the cache behaviour is worse. `lib/ai/anthropic-cache-breakpoints.ts`
 * puts the prompt-cache breakpoint over tools+system, so anything that grows the
 * tools array invalidates the cached prefix on EVERY turn of EVERY conversation,
 * including the ones that never touch the desktop.
 *
 * Progressive reveal does not help here, and it is worth saying why because it looks
 * like it should: `tool-reveal.ts` trims DESCRIPTIONS, not SCHEMAS
 * (`trimPropertyMap` rewrites `description` and leaves `enum`, `type` and `default`
 * alone), and schemas are the expensive half.
 *
 * A schema delivered as a tool RESULT is paid once, in the turn that asked for it,
 * and never enters the cached prefix.
 *
 * # One spawn, not fifty-six
 *
 * `describe <tool>` is ~35 ms and there are 56 of them; `dump-docs --type json` is
 * one 50 ms spawn returning all of them (120 KB). The first draft of this used 56
 * `describe` calls because that is the command the self-test already used — the
 * cheaper one was in `--help` the whole time.
 *
 * # Trimming is not an optimisation here, it is part of the guard
 *
 * The raw `click` schema is 6.3 KB, and a fair amount of that describes addressing
 * modes Atlarix does not offer. What is removed and why:
 *
 *   - `session` — host-owned; we open one per turn (see `dispatch.ts`).
 *   - `scope` — its only non-default value is `"desktop"`, which is refused
 *     outright. Advertising a parameter whose only interesting value is refused
 *     wastes tokens and invites a refusal.
 *   - `target` — REWRITTEN rather than removed, to its window branch alone.
 *     `move_cursor` has no top-level `pid` at all, so dropping `target` would leave
 *     it unaddressable; keeping only `{kind:"window", pid, window_id}` keeps it
 *     usable and makes the desktop form unexpressible in the schema. That is the
 *     same technique as the closed `key` enum on the `computer` tool: a capability
 *     absent from the schema is one the model cannot express, which beats one it
 *     expresses and gets refused for.
 *   - `element_index` / `snapshot_id` / `element_token` — replaced by `ref`. The
 *     model never holds a driver token; Atlarix mints `d3.7`-style refs and holds
 *     the token itself (`refs.ts`). Three fields become one, and the ref is what
 *     lets `guardTypeTarget` see the element's role before anything is typed.
 *   - `screenshot_out_file` / `debug_image_out` / `output_dir` — model-chosen
 *     filesystem destinations. See `dispatch.ts`.
 */
import log from "electron-log";
import { dumpDocsJson, type RawDriverTool } from "./driver-session";
import { DISPATCH, HOST_OWNED_FIELDS, REFUSED_FIELDS } from "./dispatch";

const logger = log.scope("computer-use");

export interface DriverToolDoc {
  name: string;
  description: string;
  properties: Record<string, unknown>;
  required?: string[];
}

/** Fields we replace with `ref`, because the model never holds a driver token. */
const TOKEN_FIELDS = ["element_index", "snapshot_id", "element_token"];

const REF_PROPERTY = {
  type: "string",
  description:
    'Element ref from computer_inspect (e.g. "d3.7"). Preferred over x,y: it survives ' +
    "a moved window and names what is being touched.",
};

/**
 * Trim a description to `max`, cutting at a paragraph or sentence boundary.
 *
 * Never mid-word and never mid-sentence: a truncated schema description is read by a
 * model as a complete instruction, so half a sentence is worse than a shorter whole
 * one.
 */
function trimText(s: string, max: number): string {
  const t = s.trim();
  if (t.length <= max) return t;
  const cut = t.slice(0, max);
  for (const sep of ["\n\n", ". ", "\n"]) {
    const i = cut.lastIndexOf(sep);
    if (i > max * 0.5) return cut.slice(0, sep === ". " ? i + 1 : i).trim();
  }
  return `${cut.trim()}…`;
}

/** The window branch of the driver's `target`, with the desktop branch removed. */
const WINDOW_TARGET = {
  type: "object",
  properties: {
    kind: { const: "window", type: "string" },
    pid: { type: "integer" },
    window_id: { type: "integer" },
  },
  required: ["kind", "pid", "window_id"],
  description: "Explicit window target. Only the window form is available in Atlarix.",
};

function trimProperty(p: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const k of ["type", "enum", "const", "items", "default"]) {
    if (k in p) out[k] = p[k];
  }
  if (typeof p.description === "string") out.description = trimText(p.description, 160);
  return out;
}

export function trimToolDoc(raw: RawDriverTool): DriverToolDoc | null {
  const name = raw.name;
  if (!name) return null;
  const props = raw.input_schema?.properties ?? {};
  const out: Record<string, unknown> = {};
  let sawToken = false;

  for (const [key, value] of Object.entries(props)) {
    if (HOST_OWNED_FIELDS.includes(key)) continue;
    if (REFUSED_FIELDS.includes(key)) continue;
    if (key === "scope") continue;
    if (TOKEN_FIELDS.includes(key)) {
      sawToken = true;
      continue;
    }
    if (key === "target") {
      out.target = WINDOW_TARGET;
      continue;
    }
    out[key] = trimProperty(value);
  }
  if (sawToken) out.ref = REF_PROPERTY;

  const required = (raw.input_schema?.required ?? []).filter(
    (r) => !HOST_OWNED_FIELDS.includes(r) && !REFUSED_FIELDS.includes(r) && !TOKEN_FIELDS.includes(r),
  );

  return {
    name,
    description: trimText(raw.description ?? "", 450),
    properties: out,
    ...(required.length ? { required } : {}),
  };
}

/** Trimmed once; `dumpDocsJson` does the mtime-keyed caching of the raw document. */
let cache: Map<string, DriverToolDoc> | null = null;

/**
 * Every model-facing tool's trimmed schema.
 *
 * `dumpDocsJson` reads the binary's own registry — no daemon, no socket, no TCC
 * grant and no GUI session, the same reason `self-test.ts` can assert the driver
 * contract on a headless CI runner. Starting a daemon to read documentation would
 * make a cheap call expensive and, on macOS, could provoke a permission prompt at a
 * moment the user has no context for.
 */
export async function driverToolCatalogue(): Promise<Map<string, DriverToolDoc>> {
  if (cache) return cache;
  const tools = await dumpDocsJson();

  const docs = new Map<string, DriverToolDoc>();
  for (const t of tools) {
    if (!t.name || !(t.name in DISPATCH)) continue;
    const doc = trimToolDoc(t);
    if (doc) docs.set(doc.name, doc);
  }
  logger.info(`[computer-use] catalogued ${docs.size} model-facing driver schemas`);
  cache = docs;
  return docs;
}

/** One tool's schema, or a message naming the discovery path. */
export async function describeDriverTool(
  name: string,
): Promise<{ ok: true; doc: DriverToolDoc } | { ok: false; error: string }> {
  const docs = await driverToolCatalogue();
  const doc = docs.get(name);
  if (!doc) {
    return {
      ok: false,
      error:
        `No schema for "${name}" — it is not one of the tools computer_call can reach. ` +
        `computer_call's description lists every valid name.`,
    };
  }
  return { ok: true, doc };
}

/** Tests only. */
export function resetCatalogueForTests(): void {
  cache = null;
}
