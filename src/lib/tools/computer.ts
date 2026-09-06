/**
 * `computer_inspect` + `computer` — eyes and hands on the rest of the desktop.
 *
 * WHY THIS EXISTS. Atlarix could drive a web page (`browser_inspect` → `browser`)
 * and a mobile emulator (`mobile_inspect` → `mobile`), and could not touch the
 * machine it runs on. This closes that: the agent reads and acts on OTHER
 * applications — Slack, Excel, Airtable, Metabase, OBS, CapCut — in the background,
 * with no cursor warp, no focus steal and no Space switching.
 *
 * AND UNLIKE MOBILE, THE REACH IS NEW. `docs/DESIGN_NOTES.md` justifies the mobile
 * pair partly with "the reach is also not new: `adb` was already available through
 * `run_command`". That argument does NOT transfer. There is no existing path by
 * which the agent can click a button in Slack, so this is a genuinely new capability
 * and the containment is its own mechanism — see `guards.ts` and `apps.ts`.
 *
 * REFS, NOT COORDINATES, and here that is not a token optimisation — it is the only
 * design that RUNS. Both Atlarix Core models are text-only (measured:
 * `z-ai/glm-5.3` and `deepseek/deepseek-v4-pro` are `input:["text"]`), so a
 * screenshot-first tool would hit `image-embed-gate.ts` on the default models for
 * Free and Pro. The accessibility tree is text, which is why every model can drive
 * this.
 *
 * THREE READ TIERS, ALL TEXT TO THE MODEL: refs (default, cheap) → refs plus an
 * annotated image for the HUMAN → local OCR for apps that draw their own surface.
 * A raw screenshot to the model is opt-in and last.
 *
 * NO PER-APP PROMPT (owner's decision). Every application is reachable except
 * Atlarix itself. On macOS the OS is the real consent gate — nothing works until
 * Accessibility and Screen Recording are granted to Atlarix by name. On Windows and
 * Linux there is no equivalent, and the docs say so rather than implying parity.
 */
import { ToolRegistry } from "./registry";
import {
  listApps,
  resolveTargetApp,
  stripSelfFromResult,
  type DesktopApp,
} from "@/lib/computer/apps";
import { MODEL_FACING_TOOLS } from "@/lib/computer/dispatch";
import { prepareDispatch } from "@/lib/computer/dispatch-guard";
import { describeDriverTool } from "@/lib/computer/tool-catalogue";
import {
  findElements,
  formatWindow,
  parseWindowSnapshot,
  type WindowSnapshot,
} from "@/lib/computer/ax-tree";
import { callDriver, ComputerUseError } from "@/lib/computer/driver-session";
import { DeskBusyError, withDesk } from "@/lib/computer/desk-lock";
import { guardTypeTarget } from "@/lib/computer/guards";
import { KEYS, isNamedKey, toDriverKey } from "@/lib/computer/keys";
import {
  detectInputRung,
  pixelDeliveryRefused,
  refusePixelAction,
} from "@/lib/computer/input-rung";
import { ocrWindow } from "@/lib/computer/ocr";
import { missingGrantMessage } from "@/lib/computer/permission-hint";
import { showOutline } from "@/lib/computer/overlay";
import {
  explainDriverStaleError,
  isDriverStaleError,
  mintRefs,
  resolveRef,
  type DesktopElement,
} from "@/lib/computer/refs";

type Args = Record<string, unknown>;
const str = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim() : "");

/**
 * Cap the driver's walk on the way IN.
 *
 * Its own default is ~2000 elements at depth 25, and its description names the
 * reason — "Electron / Obsidian / large web apps that produce 10k+ element trees".
 * Two thousand rows is a reasonable ceiling for a driver and a catastrophe for a
 * prompt, so we ask for far fewer and trim again locally.
 */
const MAX_WALK_ELEMENTS = 400;
const MAX_SHOWN = 60;

/** Turn any thrown error into the tool's failure envelope, category intact. */
function toFailure(e: unknown): { success: false; error: string } {
  if (e instanceof ComputerUseError || e instanceof DeskBusyError) {
    return { success: false, error: e.message };
  }
  const message = e instanceof Error ? e.message : String(e);
  if (isDriverStaleError(message)) {
    return { success: false, error: explainDriverStaleError("that ref", message) };
  }
  return { success: false, error: message };
}

async function snapshotWindow(
  app: DesktopApp,
  opts: { window?: string; query?: string; withImage?: boolean; shotFile?: string },
): Promise<{ parsed: ReturnType<typeof parseWindowSnapshot>; refs: DesktopElement[] }> {
  const snap = (await callDriver(
    "get_window_state",
    {
      pid: app.pid,
      ...(opts.window ? { window_id: opts.window } : {}),
      ...(opts.query ? { query: opts.query } : {}),
      max_elements: MAX_WALK_ELEMENTS,
      // `include_screenshot:false` is documented as the cheap path — "saves the
      // image tokens + screen-grab latency" — and tier 1 never needs the image.
      include_screenshot: Boolean(opts.withImage),
    },
    opts.shotFile ? { screenshotOutFile: opts.shotFile } : undefined,
  )) as WindowSnapshot;

  const parsed = parseWindowSnapshot(snap, { max: MAX_SHOWN });
  const refs = mintRefs({
    appKey: app.bundleId ?? app.name,
    pid: app.pid,
    ...(opts.window ? { windowId: opts.window } : {}),
    elements: parsed.elements,
  });
  return { parsed, refs };
}

// ── computer_inspect ────────────────────────────────────────────────────────

ToolRegistry.register({
  name: "computer_inspect",
  requiresWorkspace: false,
  isCore: false,
  isReadOnly: true,
  allowInAskMode: true,
  description:
    // THE FIRST SENTENCE IS THE WHOLE BINDING. This tool is peripheral under
    // tool-reveal in every mode, so a turn binds `firstSentence(description)` plus
    // a `tool_help` pointer and nothing else. `firstSentence` caps at 200 chars and
    // cuts at the first ". " — so this must be ONE sentence, under 200 characters,
    // with no internal ". " (and no "e.g. " either, which also cuts). It therefore
    // carries the cheap default rather than an introduction.
    //
    // `mobile_inspect`'s first sentence is 311 chars and is silently truncated,
    // losing "in a few hundred tokens" — the claim its whole design rests on.
    // Do not repeat that here.
    "Read another desktop app's window as TEXT — with just `app` it returns the accessibility tree: every element with a stable `ref` for the `computer` tool to act on, in a few hundred tokens.\n" +
    'mode:"find" — the CHEAPEST read: rank to elements matching plain words ("Send button", "search box"). Use this for "is X there".\n' +
    'mode:"text" — local OCR, for apps whose accessibility tree is empty or sparse (canvas grids, custom-drawn timelines). Slower and lossy: use it when mode:"tree" came back thin, which it will tell you.\n' +
    'mode:"som" — the element list PLUS an annotated image for the USER to see what is about to be touched. You receive the list as TEXT; the picture is for the human.\n' +
    'mode:"apps" — what is running and what its windows are called, when you need to name one. The only mode that needs no accessibility grant.\n' +
    'mode:"screenshot" — a literal PNG and a LAST RESORT (thousands of tokens), and useless on a text-only model, which will say so. NEVER to answer "what is on screen" — mode:"tree" already does that, in text.\n' +
    "Atlarix's own window is never a target and never appears in mode:\"apps\".",
  parameters: {
    type: "object",
    properties: {
      app: {
        type: "string",
        description:
          'Application name or bundle id, from mode:"apps". Required except for mode:"apps".',
      },
      mode: {
        type: "string",
        enum: ["tree", "find", "text", "som", "apps", "screenshot"],
        description: 'Default "tree" (text, cheap). "screenshot" is a PNG and a last resort.',
      },
      query: {
        type: "string",
        description: 'With mode:"find", the plain words to rank to ("submit button", "email field").',
      },
      window: {
        type: "string",
        description: "Which window, when the app has several. Optional with one.",
      },
    },
    required: [],
    additionalProperties: false,
  },
  handler: async (rawArgs: unknown) => {
    const args = (rawArgs ?? {}) as Args;
    const mode = str(args.mode) || "tree";
    try {
      if (mode === "apps") {
        const apps = await listApps();
        const lines = apps.map(
          (a) =>
            `${a.name}${a.bundleId ? ` (${a.bundleId})` : ""} pid=${a.pid}` +
            (a.windows.length
              ? ` windows: ${a.windows.map((w) => w.title || w.id || "?").slice(0, 4).join(" | ")}`
              : " (no windows)"),
        );
        return {
          success: true,
          title: "Running applications",
          content: lines.length
            ? `${lines.length} application(s) running. Name one as \`app\`.\n${lines.join("\n")}`
            : "No applications are reporting windows right now.",
        };
      }

      // ACCESSIBILITY IS CHECKED HERE, BEFORE ANY WORK, because every mode below
      // depends on it and none of them fail in a way that names it. With the grant
      // missing the driver still answers — `get_window_state` returns real bounds
      // from the window server — it just returns an EMPTY TREE. Downstream that
      // reads as "this app draws its own surface, try mode:\"text\"", which sends
      // the model to OCR that cannot work either. On a real run that cost four
      // turns and ended in the terminal refusal, with nobody ever told to open
      // System Settings.
      //
      // `mode:"apps"` is deliberately above this line: it is measured to work with
      // accessibility:false and screen_recording:false, so it stays the one read
      // that answers before any grant exists.
      const grantMissing = missingGrantMessage("accessibility");
      if (grantMissing) return { success: false, error: grantMissing };

      const resolved = await resolveTargetApp(str(args.app));
      if (!resolved.ok) return { success: false, error: resolved.error };
      const app = resolved.app;
      const window = str(args.window) || undefined;

      if (mode === "text") {
        const res = await ocrWindow(app.pid, window);
        if ("error" in res) return { success: false, error: res.error };
        const lines = res.words.map((w) => `${w.text}  @${w.x},${w.y}`);
        return {
          success: true,
          title: `${app.name} — OCR`,
          content:
            `${res.words.length} text run(s) read from ${app.name} by ${res.engine} ` +
            `(scale ${res.scale}). These are TEXT POSITIONS, not refs — there is nothing to ` +
            `act on here. Use them to read; act through the accessibility tree where it ` +
            `exists.\n${lines.join("\n")}`,
        };
      }

      if (mode === "find") {
        const query = str(args.query);
        if (!query) {
          return {
            success: false,
            error: 'mode:"find" needs a `query` describing the element ("submit button").',
          };
        }
        // The driver's own `query` projects the tree server-side, then we rank what
        // comes back — so "submit button" beats a bare substring hit on "submit".
        const { parsed, refs } = await snapshotWindow(app, { window, query });
        const hits = findElements(refs, query);
        if (hits.length === 0) {
          return {
            success: true,
            title: `${app.name} — find`,
            content:
              `Nothing matched "${query}" among ${parsed.total} elements in ${app.name}. ` +
              `Read without \`query\` to see the whole window, or scroll — it may be off-screen.`,
          };
        }
        return {
          success: true,
          title: `${app.name} — find`,
          content: formatWindow(parsed, hits, { name: app.name, pid: app.pid }),
        };
      }

      // tree | som | screenshot all take a snapshot; they differ in what comes back.
      const wantImage = mode === "som" || mode === "screenshot";
      const { parsed, refs } = await snapshotWindow(app, { window, withImage: wantImage });
      const text = formatWindow(parsed, refs, { name: app.name, pid: app.pid });

      if (mode === "screenshot") {
        return {
          success: true,
          title: `${app.name} — screenshot`,
          content:
            `${text}\n\nA PNG was captured. On a text-only model it cannot be seen — the ` +
            `element list above is the readable form, and it is what to act on.`,
        };
      }
      if (mode === "som") {
        // The list is the model's payload; the annotated image is the human's. It is
        // deliberately NOT returned in the `{mimeType, data}` shape, because
        // `buildToolModelOutput` replaces an image with a fallback string on a
        // text-only model AND DISCARDS `content` — which would throw away the very
        // thing the model needs.
        return {
          success: true,
          title: `${app.name} — outlined`,
          content: `${text}\n\nThe user can see these elements outlined on screen.`,
        };
      }
      return { success: true, title: app.name, content: text };
    } catch (e) {
      return toFailure(e);
    }
  },
});

// ── computer ────────────────────────────────────────────────────────────────

ToolRegistry.register({
  name: "computer",
  requiresWorkspace: false,
  isCore: false,
  isReadOnly: false,
  allowInAskMode: true,
  description:
    // One sentence, <200 chars, no internal ". " — see computer_inspect.
    "Act on another desktop app by element `ref` from computer_inspect — click, right_click, type, key, scroll or menu, with no coordinate form and never on Atlarix's own window.\n" +
    'action:"click" / "right_click" — act on the element at `ref`. Right-click opens its context menu.\n' +
    'action:"type" — focus `ref` and enter `text`. Refused on a password or secure field: system autofill only, so ask the user instead.\n' +
    'action:"key" — press one key via `key`. The set is closed on purpose: there is no free-form combo, so cmd+Q, alt+F4 and force-quit are not expressible.\n' +
    'action:"scroll" — `direction` up/down/left/right on `ref`\'s scrollable container.\n' +
    'action:"menu" — invoke an application menu path via `path` ("File > Export"). THIS IS THE WAY INTO CANVAS APPS: menu bars are fully exposed even where a timeline or preview is not.\n' +
    "A `ref` belongs to ONE read. The window is re-snapshotted on every act and a ref the window no longer has is refused rather than applied to whatever now sits in its place. There are no pixel coordinates: a coordinate is right for one window size and fails by SUCCEEDING on empty space at any other.\n" +
    "Terminals, shells and credential managers are never targets: typing into a terminal would be run_command with no sandbox, no danger gate and no approval card.",
  parameters: {
    type: "object",
    properties: {
      action: {
        type: "string",
        enum: ["click", "right_click", "type", "key", "scroll", "menu"],
        description: "What to do.",
      },
      ref: {
        type: "string",
        description: 'Element ref from computer_inspect (e.g. "d3.7"). Required except for "menu".',
      },
      text: { type: "string", description: 'With action:"type", what to enter.' },
      key: {
        type: "string",
        enum: [...KEYS],
        description: 'With action:"key", which key to press.',
      },
      direction: {
        type: "string",
        enum: ["up", "down", "left", "right"],
        description: 'With action:"scroll". "down" reveals content further down.',
      },
      path: {
        type: "string",
        description: 'With action:"menu", the menu path ("File > Export As > Video").',
      },
      app: {
        type: "string",
        description: 'With action:"menu" only — which app\'s menu bar. Refs carry their own app.',
      },
    },
    required: ["action"],
    additionalProperties: false,
  },
  handler: async (rawArgs: unknown) => {
    const args = (rawArgs ?? {}) as Args;
    const action = str(args.action);
    if (!action) {
      return { success: false, error: "computer needs an `action`: click, type, key, scroll or menu." };
    }

    try {
      // Same gate as the read tool, and it matters more here: without
      // Accessibility a click cannot land, and the driver does not say so — it
      // reports success against an empty tree. Refusing with the grant named beats
      // a silent no-op that the model reads as "done".
      const grantMissing = missingGrantMessage("accessibility");
      if (grantMissing) return { success: false, error: grantMissing };

      // ── menu: the only action addressed by path rather than by ref ──────────
      if (action === "menu") {
        const path = str(args.path);
        if (!path) {
          return {
            success: false,
            error: 'action:"menu" needs a `path` like "File > Export". Read the app first if unsure.',
          };
        }
        const resolved = await resolveTargetApp(str(args.app));
        if (!resolved.ok) return { success: false, error: resolved.error };
        const app = resolved.app;
        return await withDesk(`${app.name} menu`, async () => {
          await callDriver("invoke_menu", {
            pid: app.pid,
            path: path.split(">").map((p) => p.trim()).filter(Boolean),
          });
          return {
            success: true,
            title: app.name,
            content: `Invoked ${path} in ${app.name}. Re-read the window — a menu item usually changes it.`,
          };
        });
      }

      const ref = str(args.ref);
      if (!ref) {
        return {
          success: false,
          error: `action:"${action}" needs a \`ref\` from computer_inspect. There is no coordinate form.`,
        };
      }
      const found = resolveRef(ref);
      if (!found.ok) return { success: false, error: found.error };
      const { element, pid } = found;

      // EVERYTHING FROM HERE IS UNDER THE DESK LOCK. Snapshot-then-act must be
      // atomic: the driver's index map is replaced by the next snapshot of the same
      // window, and there is one focus and one cursor for five possible workers.
      return await withDesk(`${element.role} "${element.label}"`, async () => {
        // Outline what is about to be touched. Best-effort and never awaited into
        // the action's success: a visual nicety must not be the reason an act
        // fails. Frames are window-relative, so the window origin is added here.
        try {
          const wb = (await callDriver("list_windows", { pid })) as {
            windows?: Array<{ x?: number; y?: number }>;
          };
          const origin = wb?.windows?.[0] ?? {};
          showOutline({
            x: (Number(origin.x) || 0) + element.frame.x,
            y: (Number(origin.y) || 0) + element.frame.y,
            w: element.frame.w,
            h: element.frame.h,
            label: element.label || element.role,
          });
        } catch {
          /* no outline; the action continues regardless */
        }

        if (action === "click" || action === "right_click") {
          await callDriver("click", {
            pid,
            element_token: element.token,
            ...(action === "right_click" ? { button: "right" } : {}),
          });
          return {
            success: true,
            title: element.label || element.role,
            content: `${action === "right_click" ? "Right-clicked" : "Clicked"} ${element.role}${element.label ? ` "${element.label}"` : ""}. Re-read the window if this navigated.`,
          };
        }

        if (action === "type") {
          const text = typeof args.text === "string" ? args.text : "";
          if (!text) {
            return { success: false, error: 'action:"type" needs a non-empty `text`.' };
          }
          const guard = guardTypeTarget(element);
          if (!guard.allowed) return { success: false, error: guard.reason };
          await callDriver("type_text", { pid, element_token: element.token, text });
          return {
            success: true,
            title: element.label || element.role,
            content: `Typed into ${element.role}${element.label ? ` "${element.label}"` : ""}.`,
          };
        }

        if (action === "key") {
          const key = str(args.key);
          if (!isNamedKey(key)) {
            return {
              success: false,
              error:
                `"${key}" is not in the supported key set (${KEYS.join(", ")}). The set is ` +
                `closed on purpose so no destructive combination is expressible. Do not retry ` +
                `with a different spelling.`,
            };
          }
          // TRANSLATED, not passed through. These are OUR names; the driver
          // publishes a different vocabulary (`return`, `pageup`, and no
          // `select_all` at all — that one is `a` with a cmd modifier). See
          // `keys.ts` for the two vocabularies and why they diverged.
          const dk = toDriverKey(key);
          await callDriver("press_key", {
            pid,
            element_token: element.token,
            key: dk.key,
            ...(dk.modifiers ? { modifiers: dk.modifiers } : {}),
          });
          return { success: true, title: element.label || element.role, content: `Pressed ${key}.` };
        }

        if (action === "scroll") {
          const direction = str(args.direction) || "down";
          // Scrolling is the one act that may need the pixel rung, so it is the one
          // that can hit rung 4. Check before acting rather than after.
          const rung = await detectInputRung();
          if (pixelDeliveryRefused(rung)) {
            return { success: false, error: refusePixelAction("scroll") };
          }
          await callDriver("scroll", { pid, element_token: element.token, direction });
          return {
            success: true,
            title: element.label || element.role,
            content: `Scrolled ${direction}. Re-read the window — refs from before this may be gone.`,
          };
        }

        return { success: false, error: `Unknown action "${action}".` };
      });
    } catch (e) {
      return toFailure(e);
    }
  },
});

// ── computer_call ───────────────────────────────────────────────────────────

/**
 * THE FULL DRIVER SURFACE, through one tool.
 *
 * `computer_inspect` + `computer` reach 8 of cua-driver's 56 tools. That was a
 * prompt-budget decision and it was a real capability ceiling: the nine `browser_*`
 * tools (which read a REAL logged-in browser's DOM over CDP, needing no macOS grant)
 * and `clipboard_read` and `launch_app` were all unreachable, and the model shelled
 * out to `open -a` because of the last one and then walked into the terminal
 * refusal.
 *
 * The curated pair stays as the cheap default for the common case — read a window,
 * click a ref. This is the escape hatch, and it costs the prompt one parameter
 * schema and a list of names rather than 56 schemas. See `tool-catalogue.ts` for why
 * that difference is about the prompt CACHE and not only about tokens.
 *
 * EVERY GUARD IS IN `dispatch-guard.ts`, not here. This function's job is to hand
 * `{tool, input}` to `prepareDispatch`, take the lock the spec asks for, and turn
 * the result into a tool envelope. A guard added to this handler instead of to that
 * file is a guard the tests do not reach.
 */
ToolRegistry.register({
  name: "computer_call",
  requiresWorkspace: false,
  isCore: false,
  isReadOnly: false,
  allowInAskMode: true,
  description:
    // ONE sentence, <200 chars, no internal ". " — see computer_inspect for why.
    "Call one cua-driver tool directly by name — the full desktop surface beyond `computer`: browsers, clipboard, app launch, window frames, zoom, drag and pixel-addressed input.\n" +
    'Pass describe:true with a `tool` to get that tool\'s parameters before calling it. Schemas are not in this prompt — fetch the one you need, once.\n' +
    "Prefer `ref` over x,y wherever a tool takes one: a ref comes from computer_inspect, survives a moved window, and names what is being touched.\n" +
    "The browser_* tools attach to the user's REAL browser and read logged-in pages (Airtable, Metabase, an admin console) with no screenshot and no macOS grant — start with browser_prepare, then get_browser_state.\n" +
    "Atlarix's own window is never a target, terminals and credential managers are never targets, and there is no screen-absolute (whole-desktop) coordinate form.",
  parameters: {
    type: "object",
    properties: {
      tool: {
        type: "string",
        // THE NAMES LIVE IN THE ENUM, not in the description. An enum is what a
        // model's constrained decoding can actually hold it to, and it is the same
        // token cost either way.
        enum: [...MODEL_FACING_TOOLS],
        description: "Which driver tool to call.",
      },
      input: {
        type: "object",
        description:
          "The tool's parameters. Use describe:true first if you do not know them.",
      },
      describe: {
        type: "boolean",
        description: "Return the tool's parameters instead of calling it.",
      },
    },
    required: ["tool"],
    additionalProperties: false,
  },
  handler: async (rawArgs: unknown) => {
    const args = (rawArgs ?? {}) as Args;
    const tool = str(args.tool);
    if (!tool) {
      return {
        success: false,
        error: "computer_call needs a `tool` name. Its `tool` parameter lists every valid one.",
      };
    }

    try {
      if (args.describe === true) {
        const doc = await describeDriverTool(tool);
        if (!doc.ok) return { success: false, error: doc.error };
        return {
          success: true,
          title: `${tool} — parameters`,
          content:
            `${doc.doc.description}\n\nParameters (as Atlarix accepts them — the driver's own ` +
            `session, screen-absolute and file-path fields are not offered):\n` +
            JSON.stringify(
              { properties: doc.doc.properties, ...(doc.doc.required ? { required: doc.doc.required } : {}) },
              null,
              1,
            ),
        };
      }

      // The grant gate, before any work. Same reasoning as the other two tools:
      // without Accessibility the driver still ANSWERS, with an empty tree, and a
      // model reads that as "nothing there" rather than "ask for permission".
      // browser_* is the exception the driver documents — CDP needs no TCC — so it
      // is deliberately allowed through.
      if (!tool.startsWith("browser_") && tool !== "get_browser_state") {
        const grantMissing = missingGrantMessage("accessibility");
        if (grantMissing) return { success: false, error: grantMissing };
      }

      const prep = await prepareDispatch(tool, args.input);
      if (!prep.ok) return { success: false, error: prep.error };
      const { input, spec, app, label } = prep.prepared;

      /**
       * THE IRREVERSIBLE PAIR, and an honest note about what this gate is.
       *
       * This is a two-step confirm by the MODEL, in the shape cua-driver uses for
       * `install_ffmpeg` — not a user approval card. A real card means a new
       * operation in `PermissionInterceptor`, a preview type, an executor and a
       * renderer component; a `__permission_required` envelope carrying an operation
       * the renderer cannot draw would hang the turn on approval that never appears,
       * which is worse than this. The card is the right end state and is written up
       * as outstanding rather than quietly skipped.
       */
      if (spec.needsApproval && input.confirm !== true) {
        if (!spec.driverConfirm) delete input.confirm;
        return {
          success: false,
          error:
            `${tool} is irreversible${app ? ` and would act on ${app.name}` : ""} — ` +
            `\`kill_app\` discards unsaved work with no undo, and a download writes a file. ` +
            `Nothing was done. If the user has asked for this, call again with ` +
            `input.confirm: true. If they have not, ask them first with ask_user.`,
        };
      }
      // Only ours. `install_ffmpeg` owns a `confirm` of its own — see driverConfirm.
      if (!spec.driverConfirm) delete input.confirm;

      const call = async () => {
        const raw = await callDriver(tool, input);
        const result = spec.selfFilterResult ? stripSelfFromResult(tool, raw) : raw;
        /**
         * A HARD CEILING ON THE RESULT, because this path has no formatter.
         *
         * `computer_inspect` reads the same `get_window_state` and renders 60
         * elements as a few hundred tokens. Here the driver's raw payload goes
         * straight back, and a dense window is tens of thousands of characters of
         * tokens and frames the model cannot use — it holds no driver tokens. So it
         * is cut, and the cut SAYS which tool renders it properly rather than
         * leaving a truncated JSON document to be puzzled over.
         */
        const json = JSON.stringify(result) ?? "";
        const cut = json.length > 6_000;
        return {
          success: true,
          title: label,
          content:
            `${tool} → ${json.slice(0, 6_000)}\n` +
            (cut
              ? `[cut at 6,000 of ${json.length} characters. For a window's contents use ` +
                `computer_inspect, which renders the same read as text with refs you can act on.]\n`
              : "") +
            (spec.act
              ? "Re-read the window if this changed it — refs from before this may be gone."
              : ""),
        };
      };

      // Reads take no lock at all; acts take the lane their spec names. See
      // `desk-lock.ts` for why the browser is a separate lane and not the same one.
      if (!spec.act) return await call();
      return await withDesk(label, call, { lane: spec.lane ?? "desk" });
    } catch (e) {
      return toFailure(e);
    }
  },
});
