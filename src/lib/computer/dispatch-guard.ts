/**
 * Everything that has to be true before a `computer_call` reaches the driver.
 *
 * `dispatch.ts` is the table — which tools exist and which of their fields matter.
 * This is the code that reads it. The two are split because the table is a list of
 * DECISIONS (reviewable by someone who does not read TypeScript) and this is a list
 * of MECHANISMS, and mixing them is how a decision gets buried in a control flow.
 *
 * # The order below is the design, not an implementation detail
 *
 * Each step exists because the step after it cannot see what the step before it
 * catches:
 *
 *  1. **Name** — is this tool reachable at all. Nothing else runs on a denied name.
 *  2. **Screen-absolute scope** — before any target resolution, because its whole
 *     nature is having NO target. A check that runs "per target field" never fires
 *     on a call that names no target.
 *  3. **Refused fields** — the filesystem and process capabilities that reach around
 *     the command-permission system. Refused, not stripped: the field is the request.
 *  4. **Host-owned fields** — stripped. Ours to set; a model setting them is a
 *     harmless mistake.
 *  5. **Ref → token** — before target resolution, because a ref CARRIES a pid and
 *     that pid must be vetted like any other.
 *  6. **Targets** — pid, bundle id, and `window_id`, each through the one seam in
 *     `apps.ts`. This is where Atlarix, terminals and credential surfaces are refused.
 *  7. **Typing** — needs the resolved ELEMENT, so it cannot run before step 5.
 *  8. **Keys** — the chord allowlist, for both `hotkey` and `press_key`'s modifiers.
 *  9. **Pixels** — needs the resolved pid from step 6 to ask "was this window read".
 *
 * # What this file will not paper over
 *
 * `type_text` and `set_value` require a `ref`. `guardTypeTarget` is what stops
 * Atlarix typing into a password box, and it reads an element's ROLE — with raw
 * coordinates there is no element and therefore no check, only a hope. The driver's
 * own docs describe a pixel-click-then-type path for backgrounded Electron inputs;
 * that path is available through the `computer` tool, which types at a ref. Typing
 * blind at a coordinate is the one thing not offered, and the refusal says so.
 *
 * KNOWN RESIDUAL, stated rather than left for someone to find: `clipboard_write`
 * plus an allowed `cmd+V` is an unguarded route to putting text into a focused
 * field, including a secure one. It is materially harder to misuse — the model must
 * already hold the text — and closing it would mean guarding paste by target, which
 * needs an element, which is the same problem. Worth knowing; not worth a half-guard
 * that reads as protection.
 */
import log from "electron-log";
import {
  isSelf,
  resolveTargetApp,
  resolveTargetPid,
  selfTargetRefusal,
  type DesktopApp,
} from "./apps";
import { callDriver } from "./driver-session";
import { guardTargetApp, guardTypeTarget } from "./guards";
import { chordFromPressKey, guardChord, isNamedKey, toDriverKey } from "./keys";
import { detectInputRung, refusePixelAction } from "./input-rung";
import { downloadRoot } from "./manifest";
import { hasRecentReadFor, resolveRef } from "./refs";
import {
  classifyTool,
  DESKTOP_SCOPE_REFUSAL,
  HOST_OWNED_FIELDS,
  REFUSED_FIELDS,
  refusedFieldReason,
  usesDesktopScope,
  type DispatchSpec,
} from "./dispatch";

const logger = log.scope("computer-use");

/** Matches `computer_inspect`'s own ceiling — see the note at step 10. */
const MAX_WALK_ELEMENTS = 400;

export interface PreparedDispatch {
  tool: string;
  /** What actually goes to the driver: normalised, stripped, host fields filled in. */
  input: Record<string, unknown>;
  spec: DispatchSpec;
  /** The vetted target, when the call named one. */
  app?: DesktopApp;
  /** For the lock's busy message and the activity row. */
  label: string;
}

export type DispatchPrep =
  | { ok: true; prepared: PreparedDispatch }
  | { ok: false; error: string };

const fail = (error: string): DispatchPrep => ({ ok: false, error });

/** Read a dotted path like `target.pid` out of an input object. */
function readPath(input: Record<string, unknown>, dotted: string): unknown {
  return dotted.split(".").reduce<unknown>(
    (node, key) =>
      node && typeof node === "object" ? (node as Record<string, unknown>)[key] : undefined,
    input,
  );
}

function writePath(input: Record<string, unknown>, dotted: string, value: unknown): void {
  const parts = dotted.split(".");
  let node: Record<string, unknown> = input;
  for (const key of parts.slice(0, -1)) {
    const next = node[key];
    if (!next || typeof next !== "object") return;
    node = next as Record<string, unknown>;
  }
  node[parts[parts.length - 1]!] = value;
}

/**
 * Which process owns a window id.
 *
 * `window_id` is a target field like `pid` is, and it is the one that is easy to
 * miss: several tools accept it INSTEAD of a pid, so a call carrying only a window
 * id names an application without ever mentioning one. Left unresolved, that is a
 * complete route to Atlarix's own window — the thing ruled out first and by name.
 *
 * The lookup costs one extra driver call, on the minority of calls that address a
 * window directly. `list_windows` with no pid is the only way to map the id back,
 * and it needs no TCC grant.
 */
async function pidForWindow(windowId: unknown): Promise<number | null> {
  const wanted = String(windowId ?? "").trim();
  if (!wanted) return null;
  try {
    const raw = (await callDriver("list_windows", {})) as {
      windows?: Array<{ window_id?: unknown; pid?: unknown }>;
    };
    for (const w of raw?.windows ?? []) {
      if (String(w.window_id ?? "") === wanted && typeof w.pid === "number") return w.pid;
    }
  } catch {
    // A lookup we cannot do is not a lookup we may skip — see the caller.
  }
  return null;
}

/**
 * Vet everything a call names, and normalise what reaches the driver.
 *
 * @param tool     the driver tool the model asked for
 * @param rawInput its input, exactly as the model wrote it
 */
export async function prepareDispatch(
  tool: string,
  rawInput: unknown,
): Promise<DispatchPrep> {
  // 1. NAME.
  const verdict = classifyTool(tool);
  if (!verdict.allowed) return fail(verdict.reason);
  const spec = verdict.spec;
  const name = String(tool).trim();

  if (rawInput != null && (typeof rawInput !== "object" || Array.isArray(rawInput))) {
    return fail(`computer_call's \`input\` must be an object, not ${typeof rawInput}.`);
  }
  const input: Record<string, unknown> = { ...((rawInput ?? {}) as Record<string, unknown>) };

  // 2. SCREEN-ABSOLUTE SCOPE, before anything that reads a target.
  if (usesDesktopScope(input)) return fail(DESKTOP_SCOPE_REFUSAL);

  // 3. REFUSED FIELDS.
  for (const field of REFUSED_FIELDS) {
    if (field in input) return fail(refusedFieldReason(name, field));
  }

  // 4. HOST-OWNED FIELDS.
  for (const field of HOST_OWNED_FIELDS) delete input[field];
  // And the one host-owned field with a value rather than an absence: the driver
  // proves a download lands inside the approved directory, and the directory is
  // ours.
  if (name === "browser_download") input.destination_root = downloadRoot();

  // 5. REF → TOKEN. Done before targets because a ref carries a pid.
  //
  // `spec.pageRef` is the tools whose `ref` is the DRIVER's page namespace
  // (`p<snapshot>:<index>` from `get_browser_state`) rather than ours (`d3.7`).
  // Translating one of those would refuse it as malformed and break every
  // browser_click and browser_type — see `dispatch.ts`.
  let element: { role: string; label: string; value?: string } | null = null;
  if (!spec.pageRef && typeof input.ref === "string" && input.ref.trim()) {
    const found = resolveRef(input.ref);
    if (!found.ok) return fail(found.error);
    delete input.ref;
    input.element_token = found.element.token;
    // The ref's pid is authoritative; a mismatched one in the same call is a
    // confusion worth resolving in favour of the thing that names an element.
    input.pid = found.pid;
    element = found.element;
  }

  // 6. TARGETS. Every declared field, through the one seam in apps.ts.
  let app: DesktopApp | undefined;
  const kind = spec.appTargetKind ?? "running";
  for (const field of spec.appTarget ?? []) {
    const value = readPath(input, field);
    if (value === undefined || value === null || value === "") continue;

    if (kind === "identity") {
      // `launch_app`: the app is not running yet, so there is nothing to resolve
      // against. The NAME is still checkable, and it is what the class guards read.
      const named = String(value);
      if (isSelf({ name: named, bundleId: named })) return fail(selfTargetRefusal());
      const guard = guardTargetApp({ name: named, bundleId: named });
      if (!guard.allowed) return fail(guard.reason);
      continue;
    }

    const resolved =
      field.endsWith("pid")
        ? await resolveTargetPid(value)
        : await resolveTargetApp(String(value));
    if (!resolved.ok) return fail(resolved.error);
    app = resolved.app;
    // Write the resolved pid back, so a bundle id becomes the pid the driver wants
    // and a resolved target cannot drift from the one that was vetted.
    if (field.endsWith("pid")) writePath(input, field, resolved.app.pid);
  }

  // 6b. WINDOW ID — a target that names no application.
  if ("window_id" in input && input.window_id !== undefined && input.window_id !== null) {
    const owner = await pidForWindow(input.window_id);
    if (owner === null) {
      return fail(
        `No open window has id ${JSON.stringify(input.window_id)}. Window ids come from ` +
          `computer_inspect and change when a window is closed and reopened — re-read and ` +
          `use a current one.`,
      );
    }
    const resolved = await resolveTargetPid(owner);
    if (!resolved.ok) return fail(resolved.error);
    app = app ?? resolved.app;
  }

  // 7. TYPING.
  for (const field of spec.typesInto ?? []) {
    if (!(field in input)) continue;
    if (!element) {
      // `clipboard_write` types into no target at all, so it is not covered by this
      // and does not need to be.
      if (!spec.appTarget?.length) continue;
      return fail(
        `Typing through computer_call needs a \`ref\` from computer_inspect, not ` +
          `coordinates. The check that stops Atlarix typing into a password field reads ` +
          `the element's role, and a coordinate has no element — so this would be typing ` +
          `blind. Read the window, then use the \`computer\` tool with action:"type", or ` +
          `pass a ref here.`,
      );
    }
    const guard = guardTypeTarget(element);
    if (!guard.allowed) return fail(guard.reason);
  }

  // 8. KEYS.
  if (name === "hotkey") {
    const keys = Array.isArray(input.keys) ? input.keys.map((k) => String(k ?? "")) : [];
    const chord = guardChord(keys);
    if (!chord.allowed) return fail(chord.reason);
    input.keys = chord.keys;
  }
  if (name === "press_key") {
    const chordKeys = chordFromPressKey(input);
    if (chordKeys) {
      // press_key with modifiers IS a chord, whatever its name says.
      const chord = guardChord(chordKeys);
      if (!chord.allowed) return fail(chord.reason);
      input.modifiers = chord.keys.slice(0, -1);
      input.key = chord.keys[chord.keys.length - 1];
    } else {
      // A bare key. Accept our own vocabulary as well as the driver's, and
      // translate — see `keys.ts` for why the two differ.
      const raw = String(input.key ?? "").trim().toLowerCase();
      if (isNamedKey(raw)) {
        const dk = toDriverKey(raw);
        input.key = dk.key;
        if (dk.modifiers) input.modifiers = dk.modifiers;
      }
    }
  }
  // `click` carries its own `modifier` array — a modifier-click, not a shortcut, but
  // still a place an unknown modifier name should not reach the driver.
  if (Array.isArray(input.modifier)) {
    const chord = guardChord([...input.modifier.map((m) => String(m ?? "")), "c"]);
    if (!chord.allowed && /not a modifier/i.test(chord.reason)) return fail(chord.reason);
  }

  // 9. PIXELS.
  const pixelAddressed = spec.pixels && !element && ("x" in input || "y" in input);
  if (pixelAddressed) {
    const rung = await detectInputRung();
    if (rung === "refuse") return fail(refusePixelAction(name));
    const pid = typeof input.pid === "number" ? input.pid : app?.pid;
    // NO TARGET AT ALL. The driver would refuse this itself, but only after the
    // read-pairing check below had silently not applied — and "the next layer
    // happens to catch it" is not a check. Refuse here, where the reason is known.
    if (typeof pid !== "number") {
      return fail(
        `Coordinates with no application. ${name} needs a \`pid\` (or a \`ref\`) naming which ` +
          `window they are in — there is no whole-screen coordinate form. Read an app with ` +
          `computer_inspect and use the pid it reports.`,
      );
    }
    if (!hasRecentReadFor(pid)) {
      return fail(
        `Acting on coordinates in ${app?.name ?? `pid ${pid}`} without reading it first is ` +
          `not allowed — a coordinate is right for one window size and fails by SUCCEEDING ` +
          `on empty space at any other. Read the window with computer_inspect (mode:"tree", ` +
          `or mode:"text" for a canvas app), then act on what it reported.`,
      );
    }
  }

  /**
   * 10. THE WALK CEILING — a prompt guard, not a security one, but the failure is
   * just as real.
   *
   * The driver's own `max_elements` default is ~2000, and its description names the
   * reason: "Electron / Obsidian / large web apps that produce 10k+ element trees".
   * `computer_inspect` caps the walk at 400 and then trims to 60 for display;
   * `computer_call` reaches the same tool with the raw default, so an unlucky
   * `get_window_state` would return a tree several times the size of the entire
   * system prompt. Clamped rather than refused: the call is reasonable, the number
   * is not.
   */
  if (typeof input.max_elements === "number") {
    input.max_elements = Math.min(input.max_elements, MAX_WALK_ELEMENTS);
  } else if ("max_elements" in input || name === "get_window_state") {
    input.max_elements = MAX_WALK_ELEMENTS;
  }

  const label = app ? `${app.name} ${name}` : name;
  logger.info(`[computer-use] dispatch ${name}${app ? ` → ${app.name} (${app.pid})` : ""}`);
  return { ok: true, prepared: { tool: name, input, spec, ...(app ? { app } : {}), label } };
}
