/**
 * The guarded dispatch table for cua-driver's full tool surface.
 *
 * # Why this file exists
 *
 * `computer_inspect` + `computer` reach 8 of the driver's 56 tools. That was a
 * prompt-budget decision and it capped what the model could do: the nine `browser_*`
 * tools (which read a real logged-in browser's DOM) and `clipboard_read` and
 * `launch_app` were all unreachable, and the model shelled out to `open -a` because
 * of the last one.
 *
 * Registering 56 tools would cost ~6,000 tokens a turn and, worse, invalidate the
 * prompt cache on every turn — `lib/ai/anthropic-cache-breakpoints.ts` puts the
 * breakpoint over tools+system, so growing the tools array busts the cached prefix.
 * Note that progressive reveal does NOT help here: `tool-reveal.ts` trims
 * DESCRIPTIONS, not SCHEMAS, and schemas are the expensive half.
 *
 * So one dispatch tool carries the names, schemas are fetched at runtime through
 * `describe`, and this table is what keeps the guards attached.
 *
 * # THE THING THIS FILE IS ACTUALLY FOR
 *
 * A naive dispatcher — hand `{tool, input}` to `callDriver` — silently deletes every
 * containment guarantee in the feature, because the guards live at
 * `resolveTargetApp()` (`apps.ts:144`) and a raw `pid` in `input` never passes
 * through it. Specifically it would hand back:
 *
 *   - Atlarix as a target, by pid, which the owner ruled out first and by name:
 *     a tool that can click our own approval buttons invalidates everything else.
 *   - `type_text` into Terminal — `run_command` with no sandbox, no danger gate, no
 *     approval card and no ruleset evaluation.
 *   - `press_key`/`hotkey` with `cmd+Q`, which the closed KEYS enum exists to make
 *     inexpressible.
 *   - Reads of a password manager's window, where the contents ARE the secret.
 *
 * Every entry below therefore declares which of its input fields name a target, so
 * one resolve covers every tool at once rather than each call remembering.
 *
 * # The field names are MEASURED, not guessed
 *
 * Taken from `cua-driver describe <tool>` on 2026-09-05, not from reading the tool
 * names and inferring. An earlier version of `ocr.ts` invented `window.bounds` and
 * `window.scale` where the real fields are `window_bounds` and `screenshot_scale`;
 * because both are read with `?? 0` / `?? 1` defaults, that produced origin 0,0 and
 * scale 1 — window pixels presented as screen coordinates, a bug that looks like
 * success and clicks in the wrong place. Re-derive from `describe` before editing.
 */

/**
 * ESCAPE HATCHES THAT DEFEAT EVERY OTHER CHECK — refused on every tool, first,
 * before any target resolution.
 *
 * Measured on `click`, `drag`, `hotkey`, `press_key`, `scroll`, `type_text` and
 * `move_cursor`. Two forms, and either one alone is a complete bypass:
 *
 *   scope: "desktop"                     — the driver's own words: "Pass `desktop`
 *                                          when sending x,y with NO pid/window_id —
 *                                          the coordinates are then true screen
 *                                          pixels."
 *   target: { kind: "desktop", display_id }
 *
 * A screen-absolute action with no pid names no app, so `resolveTargetApp` is never
 * reached and every refusal in `guards.ts` is skipped. And the frontmost application
 * when Atlarix is showing an approval card is Atlarix — which is the exact outcome
 * the owner ruled out first and by name.
 *
 * This is why the table below is not sufficient on its own: it says which FIELDS
 * name a target, and these two say "no target at all".
 */
export const DESKTOP_SCOPE_REFUSAL =
  "Screen-absolute input (scope:\"desktop\" or target.kind:\"desktop\") is not available " +
  "in Atlarix: it addresses no application, so nothing can check what it would hit — " +
  "including Atlarix's own windows. Name an app or a ref instead. Atlarix will not do " +
  "this. Do not retry.";

/** Detects both forms on any tool's input. */
export function usesDesktopScope(input: unknown): boolean {
  if (!input || typeof input !== "object") return false;
  const o = input as Record<string, unknown>;
  if (o.scope === "desktop") return true;
  const target = o.target as { kind?: unknown } | undefined;
  return Boolean(target && typeof target === "object" && target.kind === "desktop");
}

/** What a dispatched tool needs before it may reach the driver. */
export interface DispatchSpec {
  /**
   * Input fields naming a DESKTOP APP. Each is resolved through `resolveTargetApp`,
   * which is where self-target, terminal and credential-surface refusals live.
   * Absent means the tool is global (`list_apps`) or scoped to a browser target
   * rather than an app (`browser_navigate`).
   */
  appTarget?: readonly string[];
  /**
   * How an `appTarget` is checked.
   *
   * `"running"` (the default) resolves the value against `list_apps` — the full
   * three-check seam. `"identity"` checks the NAME only, because the app is not
   * running yet: `launch_app`'s whole purpose is to start something cold, so
   * resolving it against a list of running processes would refuse every legitimate
   * call with "no running application matches".
   */
  appTargetKind?: "running" | "identity";
  /** Mutates something → must hold a lock. Reads must NOT take one. */
  act?: boolean;
  /**
   * Which lock. `"browser"` for the CDP-driven tools: they have their own input
   * queue, move no system cursor and change no frontmost window, so serialising
   * them behind a desktop act would be a lock that covers more than the resource.
   */
  lane?: "desk" | "browser";
  /** Fields carrying text to be typed → `guardTypeTarget` + secure-field refusal. */
  typesInto?: readonly string[];
  /** Fields carrying key names → checked against the closed KEYS set. */
  keyFields?: readonly string[];
  /**
   * This tool's `ref` is a PAGE ref, not one of ours.
   *
   * Two ref namespaces meet in `computer_call` and they look nothing alike. Ours is
   * `d3.7` — minted by `computer_inspect`, backed by a driver element token we hold
   * (`refs.ts`). The browser tools take `p<snapshot>:<index>`, minted by
   * `get_browser_state` and meaningful only to the driver.
   *
   * The dispatcher translates OUR refs into `element_token` before dispatch. Doing
   * that to a page ref refuses it as malformed — which would have made every
   * `browser_click` and `browser_type` call fail, i.e. broken the browser surface
   * that is the main reason this tool exists. So these pass through untouched.
   */
  pageRef?: boolean;
  /**
   * Accepts raw pixel coordinates → subject to the input-rung pixel policy.
   *
   * `pixelFields` names them, and it is not decoration. The first version of the
   * guard hardcoded `"x" in input || "y" in input`, and `drag`'s coordinates are
   * `from_x`/`from_y`/`to_x`/`to_y` — it has no `x` or `y` property at all. So the
   * predicate was permanently false for the one act tool that CANNOT be addressed
   * by a ref (it carries no `element_token`), meaning coordinates are its only form
   * and the policy never looked at it. A blind drag inside a file manager moves
   * files.
   */
  pixels?: boolean;
  /** Which fields carry those coordinates. Measured, not assumed. */
  pixelFields?: readonly string[];
  /**
   * The result may name apps or windows we do not own — run it through
   * `stripSelfFromResult` before the model sees it. Needed wherever a tool can
   * answer about the whole desktop rather than about one resolved app.
   */
  selfFilterResult?: boolean;
  /**
   * Requires an explicit user approval before it runs, on top of the class guards.
   * Reserved for the irreversible: the guards answer "may this app be touched",
   * not "is destroying unsaved work what the user wanted".
   */
  needsApproval?: boolean;
  /**
   * The DRIVER has its own `confirm` parameter — do not treat it as ours.
   *
   * A NAME COLLISION worth spelling out. Atlarix's two-step gate for the
   * irreversible pair reads `input.confirm`, and strips it before dispatch because
   * it is not a driver field. `install_ffmpeg` already has a `confirm` of its own
   * (its docs: "called without `confirm` it only REPORTS the exact install command;
   * pass `confirm: true` to actually run it"). Stripping that one would make the
   * install step permanently unreachable — every call would report the command and
   * never run it, looking for all the world like the tool working.
   */
  driverConfirm?: boolean;
}

/**
 * THE 34 MODEL-FACING TOOLS. Absence from this map is a refusal — the map is the
 * allowlist, so a tool added upstream is unreachable until someone decides where it
 * belongs. That is deliberate: a new driver release must not silently widen us.
 */
export const DISPATCH: Readonly<Record<string, DispatchSpec>> = {
  // ── read ──────────────────────────────────────────────────────────────────
  get_window_state: { appTarget: ["pid"] },
  // TAKES NO PARAMETERS AT ALL, and returns "running regular apps and on-screen
  // visible windows with their bounds, z-order, and owner pid ... needs no TCC
  // grants". There is no input to guard, so the containment is entirely outbound.
  get_accessibility_tree: { selfFilterResult: true },
  // Dispatched raw, this does NOT go through `listApps()`, which is where check 3
  // (Atlarix is never listed) lives. The outbound filter is what restores it.
  list_apps: { selfFilterResult: true },
  // `pid` is OPTIONAL on `list_windows`: with no pid it returns EVERY layer-0
  // window WindowServer knows about, ours included. Declaring the field is
  // therefore only half the guard — see `stripSelfFromResult` in `apps.ts` for the
  // other half, which runs on the way out.
  list_windows: { appTarget: ["pid"], selfFilterResult: true },
  get_screen_size: {},
  zoom: { appTarget: ["pid"] },
  verify_state: { appTarget: ["pid"] },
  get_cursor_position: {},

  // ── act ───────────────────────────────────────────────────────────────────
  // Every one of these takes `pid`, and all but the menu/frame pair accept x/y.
  click: { appTarget: ["pid", "target.pid"], act: true, pixels: true, pixelFields: ["x", "y"] },
  double_click: { appTarget: ["pid"], act: true, pixels: true, pixelFields: ["x", "y"] },
  right_click: { appTarget: ["pid"], act: true, pixels: true, pixelFields: ["x", "y"] },
  scroll: { appTarget: ["pid", "target.pid"], act: true, pixels: true, pixelFields: ["x", "y"] },
  // NO `x`/`y` — measured properties are from_x, from_y, to_x, to_y. And no
  // element_token either, so a ref cannot address it: coordinates are its only form.
  drag: {
    appTarget: ["pid", "target.pid"],
    act: true,
    pixels: true,
    pixelFields: ["from_x", "from_y", "to_x", "to_y"],
  },
  // `move_cursor` has NO top-level `pid`. Measured properties are
  // {cursor_id, scope, session, target, x, y} — its only address is the NESTED
  // `target.pid`. A dispatcher that normalises `input.pid` alone leaves this tool
  // completely ungoverned, which is what the first draft of this table did.
  move_cursor: { appTarget: ["target.pid"], act: true, pixels: true, pixelFields: ["x", "y"] },
  press_key: { appTarget: ["pid", "target.pid"], act: true, pixels: true, keyFields: ["key", "modifiers"], pixelFields: ["x", "y"] },
  hotkey: { appTarget: ["pid", "target.pid"], act: true, pixels: true, keyFields: ["keys"], pixelFields: ["x", "y"] },
  type_text: { appTarget: ["pid", "target.pid"], act: true, pixels: true, typesInto: ["text"], pixelFields: ["x", "y"] },
  set_value: { appTarget: ["pid"], act: true, typesInto: ["value"] },
  invoke_menu: { appTarget: ["pid"], act: true },
  set_window_frame: { appTarget: ["pid"], act: true },

  // ── app lifecycle ─────────────────────────────────────────────────────────
  // `launch_app` names its target by bundle id or display name, never by pid —
  // it is the one place a target is resolved BEFORE a process exists.
  launch_app: { appTarget: ["bundle_id", "name"], appTargetKind: "identity", act: true },
  // `kill_app` takes ONLY a pid. Without the resolve it would happily kill
  // Atlarix, or a shell mid-command. The resolve stops it reaching us and stops
  // nothing else: `kill -9` on any app discards unsaved work with no undo, and no
  // guard can tell a stale process from someone's unsaved document. So it also
  // takes an approval card (owner's decision, 2026-09-05) — the class guards
  // answer "may this app be touched", not "did you mean to lose that".
  kill_app: { appTarget: ["pid"], act: true, needsApproval: true },

  // ── clipboard ─────────────────────────────────────────────────────────────
  // No app target: the clipboard is global. `clipboard_read` is how you get data
  // out of an app whose accessibility tree is thin, which is most of the reason
  // it is here.
  clipboard_read: {},
  clipboard_write: { act: true, typesInto: ["text"] },

  // ── browser ───────────────────────────────────────────────────────────────
  //
  // THE LARGEST RISK IN THIS FILE, ACCEPTED DELIBERATELY (owner, 2026-09-05).
  //
  // These attach to the user's REAL logged-in browser, so every authenticated
  // session they hold — bank, email, GitHub, an admin console — is one
  // `browser_navigate` away, with no per-origin consent. The desktop guards do not
  // help here: `guards.ts` refuses by app CLASS, and a browser is in neither the
  // shell nor the credential list. And the model is reading page content that may
  // itself be attacker-controlled, so prompt injection on any page it visits is a
  // path to acting inside those sessions.
  //
  // This was put to the owner with an origin-allowlist alternative (the driver
  // supports origin-scoped manifests) and a per-session approval card. Full attach
  // was chosen, knowingly, because the use case is reading their own authenticated
  // Airtable and Metabase and the alternatives break it.
  //
  // So: it is a decision, not an oversight. If it is ever revisited, the cheapest
  // mitigation is the origin-scoped manifest, not a new guard here.
  // `browser_prepare` and `get_browser_state` bind by pid (a native browser
  // window), so they resolve like any app. Everything after that is addressed by
  // `target_id`/`tab_id`, which are driver-minted session handles rather than app
  // identities — there is no app to re-resolve.
  browser_prepare: { appTarget: ["pid"] },
  get_browser_state: { appTarget: ["pid"] },
  browser_navigate: { act: true, lane: "browser" },
  browser_click: { act: true, lane: "browser", pageRef: true },
  browser_type: { act: true, lane: "browser", typesInto: ["text"], pageRef: true },
  browser_pointer: { act: true, lane: "browser", pageRef: true },
  browser_dialog: { act: true, lane: "browser" },
  // The driver marks this `destructive: true` and says it "Requires MCP-host
  // destructive-tool approval". Atlarix IS the MCP host, and had no such approval —
  // so it gets one here. `destination_root` is host-set (see HOST_OWNED_FIELDS):
  // the driver proves the file lands inside the approved directory, and the
  // directory is ours, not the model's.
  browser_download: { act: true, lane: "browser", needsApproval: true, pageRef: true },

  // ── diagnostics ───────────────────────────────────────────────────────────
  // Both were on a proposed denylist and the owner overruled it, correctly.
  // `check_for_update` is the read-only TOOL ("Read-only — never installs"), not
  // the `update --apply` CLI subcommand that would break our code signature — and
  // that subcommand is not among the 56 at all. `install_ffmpeg` is two-step
  // (reports the command unless `confirm:true`), uses the platform package
  // manager, and "ffmpeg is run as a separate process, never linked into the
  // driver", so it cannot touch our bundle, signature or notarization.
  check_for_update: {},
  install_ffmpeg: { act: true, driverConfirm: true },
};

/**
 * HOST-DRIVEN. Atlarix calls these at the right lifecycle moment; the model does
 * not. This is not withheld capability — it is the daemon's own lifecycle, and
 * handing it to a model produces bugs rather than power. `start_session` is what
 * mints the driver's agent cursor at all (it is keyed by session id), and
 * `set_agent_cursor_*` is bound to the two Settings controls that already exist.
 */
export const HOST_ONLY: ReadonlySet<string> = new Set([
  // NOT model-facing, because it contradicts the feature's own promise.
  // `bring_to_front` "persistently activates an app and leaves it in the
  // foreground", while `computer.ts` promises "no cursor warp, no focus steal" and
  // the Settings panel tells the user the agent works "without moving your cursor
  // or stealing focus". Background AX actions need no foregrounded app, so this
  // costs the model nothing — and the promise is the reason the feature is usable
  // while someone is working. Owner's decision, 2026-09-05: keep the promise.
  "bring_to_front",
  "start_session",
  "end_session",
  "get_session",
  "list_sessions",
  "set_agent_cursor_enabled",
  "set_agent_cursor_motion",
  "set_agent_cursor_theme",
  "get_agent_cursor_state",
  "check_permissions",
  "health_report",
  "get_config",
  "start_recording",
  "stop_recording",
  "get_recording_state",
]);

/**
 * REFUSED OUTRIGHT, with the reason, because a refusal that does not say why gets
 * retried. These are also excluded from the bounded capability manifest, so the
 * driver would refuse them even if this layer were bypassed — belt and braces on
 * the one list where it is warranted.
 */
export const DENIED: Readonly<Record<string, string>> = {
  // MOVED HERE FROM THE MODEL-FACING SET after reading its `describe` output, which
  // says two things the tool's name does not: it is *"Capture the full display in
  // true screen pixels with no downscale"*, and its stated purpose is to be *"the
  // coordinate source for actions whose target is {kind:\"desktop\"}"*.
  //
  // Both halves fail here. The second names the one thing Atlarix refuses outright
  // (see DESKTOP_SCOPE_REFUSAL), so its documented use case does not exist for us.
  // The first is a hole in the guarantee the owner named FIRST — a full-display
  // capture necessarily contains Atlarix's own window, including whatever approval
  // card is on it, and unlike a listing an image cannot be filtered afterwards.
  //
  // Nothing is lost: `computer_inspect mode:"screenshot"` and `zoom` both capture a
  // WINDOW, scoped to an app that has passed resolveTargetApp — and `ocr.ts` already
  // documents, with measurements, that a full-screen capture is the WRONG input for
  // reading anyway (1 nonsense word at confidence 0.3, against 6/6 at 1.0 on the
  // same pixels cropped).
  get_desktop_state:
    "A full-display capture is not available. It would include Atlarix's own window, " +
    "and its only documented purpose is screen-absolute coordinates, which Atlarix " +
    "refuses. Read one application instead — computer_inspect with mode:\"screenshot\", " +
    "or `zoom` for a region of a window.",
  replay_trajectory:
    "Trajectory replay is switched off in Atlarix by product decision. Recording is " +
    "available; replaying a recording is not.",
  set_config:
    "Changing the driver's configuration is Atlarix's job, not the model's — it can " +
    "re-enable the telemetry Atlarix deliberately switches off before the driver's " +
    "first run.",
  /**
   * AN EXFILTRATION PRIMITIVE, and the clearest one in the driver's surface.
   *
   * Its own description: "Assign one or more explicit absolute local files to an
   * exact live <input type=file> ref through CDP." That is an arbitrary local file
   * uploaded to an arbitrary web page — reached from a tool whose parameters contain
   * no command, with no sandbox, no danger gate, no approval card and no ruleset
   * evaluation. It is the terminal argument from `guards.ts`, pointed outward
   * instead of inward, and it composes with the browser tools' accepted risk: the
   * model may be reading attacker-controlled page content while it does this.
   *
   * Refusing the whole tool rather than its `files` field, because the field IS the
   * tool.
   */
  browser_set_input_files:
    "Uploading local files to a web page is not available. It would send a file from " +
    "this machine to a site, outside every check Atlarix puts on file access. Ask the " +
    "user to attach the file themselves.",
  page: "`page` is a deprecated compatibility shim. Use the browser_* tools instead.",
  escalate_session: "`escalate_session` is deprecated upstream and does nothing useful here.",
  get_session_state: "`get_session_state` is a deprecated alias. Use get_session.",
};

/** Every tool name the model may pass, for the dispatch tool's description. */
export const MODEL_FACING_TOOLS: readonly string[] = Object.keys(DISPATCH).sort();

/**
 * Fields Atlarix owns and the model must never set.
 *
 * `session` appears on nearly every driver tool. Sessions are host lifecycle — we
 * open one per turn so the driver's cursor exists at all — so a model-supplied
 * session id could address another turn's session, or a stale one. Stripped rather
 * than refused: the model passing it is a harmless mistake, not an attack, and a
 * refusal there would be noise.
 */
export const HOST_OWNED_FIELDS: readonly string[] = [
  "session",
  // FILESYSTEM DESTINATIONS THE MODEL DOES NOT CHOOSE.
  //
  // `screenshot_out_file` is how Atlarix keeps image bytes out of this process —
  // the driver writes a PNG to a path WE pick. Exposed to the model it is an
  // arbitrary-file-write primitive: a PNG at any path the app can write, with no
  // sandbox, no approval card and no ruleset evaluation, from a tool whose
  // parameters contain no path. `debug_image_out` (on `click`) is the same thing
  // wearing a debug name, and `output_dir` is the recorder's.
  //
  // Stripped rather than refused: a model passing one is making a harmless mistake
  // about who owns the field, and we overwrite it anyway.
  "screenshot_out_file",
  "debug_image_out",
  "output_dir",
  "destination_root",
];

/**
 * FIELDS THAT ARE A REFUSAL, not a strip.
 *
 * The distinction matters. A host-owned field is one we overwrite, so ignoring the
 * model's value changes nothing it cared about. These fields ARE the request: strip
 * `files` from `browser_set_input_files` and the call succeeds having uploaded
 * nothing, which teaches the model that it worked.
 *
 * Every one of them is a filesystem or process capability that reaches around the
 * command-permission system — the same argument `guards.ts` makes about terminals,
 * arriving through a tool whose parameters contain no command:
 *
 *   - `file_path` / `image_path` on `clipboard_write` load a local file INTO the
 *     clipboard, and `clipboard_read` reads it straight back out. That is an
 *     arbitrary local file read — `~/.ssh/id_rsa`, `~/.aws/credentials` — with no
 *     workspace boundary and nothing to approve.
 *   - `additional_arguments` on `launch_app` passes arbitrary argv to an arbitrary
 *     application, and `webkit_inspector_port` opens a debugging server on it.
 */
export const REFUSED_FIELDS: readonly string[] = [
  "file_path",
  "image_path",
  "additional_arguments",
  "webkit_inspector_port",
  // `launch_app.urls`, and the one I got wrong first time round.
  //
  // I refused `additional_arguments` and `webkit_inspector_port` and reasoned that
  // `urls` was benign because opening a file in an app is "close to `open`". The
  // driver's own description says what it actually is: "Optional file paths or URLs
  // to open with the app". That is the SAME capability the two entries above refuse,
  // and it composes into a complete arbitrary local file READ with nothing else that
  // is denied:
  //
  //   launch_app {bundle_id:"com.apple.TextEdit", urls:["~/.aws/credentials"]}
  //   computer_inspect {app:"TextEdit"}        ← also satisfies the read-pairing gate
  //   hotkey {pid, keys:["cmd","a"]}           ← allowed: an editing chord
  //   hotkey {pid, keys:["cmd","c"]}           ← allowed
  //   clipboard_read {}                        ← the whole file comes back
  //
  // Pointed at a browser bundle id the same field is an OUTBOUND channel. "Close to
  // `open`" was the wrong frame: `open` is not a supervised path in this app,
  // `read_file` is.
  "urls",
];

/** The refusal wording for one of those, naming the supervised alternative. */
export function refusedFieldReason(tool: string, field: string): string {
  return (
    `\`${field}\` is not available on ${tool} in Atlarix: it reaches the filesystem or ` +
    `another process outside the command-permission system, with no sandbox and no ` +
    `approval card. Atlarix will not do this. Do not retry — use read_file, write_file ` +
    `or run_command, which are the supervised paths for exactly this.`
  );
}

export type DispatchVerdict =
  | { allowed: true; spec: DispatchSpec }
  | { allowed: false; reason: string };

/**
 * Is this tool dispatchable at all? Name-level check only — target resolution and
 * the typing/key/pixel guards happen in the handler, which has the resolved app.
 */
export function classifyTool(tool: string): DispatchVerdict {
  const name = String(tool ?? "").trim();
  if (!name) {
    return {
      allowed: false,
      reason: "computer_call needs a `tool` name. Read this tool's description for the list.",
    };
  }

  const denied = DENIED[name];
  if (denied) {
    // Category 3 wording: refused by policy, permanently. No "try again".
    return { allowed: false, reason: `${denied} Atlarix will not do this. Do not retry.` };
  }

  if (HOST_ONLY.has(name)) {
    return {
      allowed: false,
      reason:
        `\`${name}\` is part of the driver's own lifecycle and Atlarix manages it — ` +
        `sessions, the agent cursor, permission and health checks. Do not retry; it is ` +
        `not something to call directly.`,
    };
  }

  const spec = DISPATCH[name];
  if (!spec) {
    // An unknown name is nearly always a near-miss, so spend a few tokens on the
    // closest matches rather than making the model re-read the whole list.
    const near = MODEL_FACING_TOOLS.filter(
      (t) => t.includes(name) || name.includes(t) || t.split("_")[0] === name.split("_")[0],
    ).slice(0, 6);
    return {
      allowed: false,
      reason:
        `No dispatchable tool named "${name}".` +
        (near.length ? ` Did you mean: ${near.join(", ")}?` : "") +
        ` This tool's description lists every valid name.`,
    };
  }

  return { allowed: true, spec };
}
