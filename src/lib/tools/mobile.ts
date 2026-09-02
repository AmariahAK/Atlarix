/**
 * `mobile_inspect` + `mobile` — eyes on, and hands on, an emulator screen.
 *
 * WHY THIS EXISTS. Atlarix could already build a mobile app and run its build
 * commands, and could see nothing it produced. A web app it can drive end to end
 * (`browser_inspect` → `browser`); a mobile app it could only compile. The
 * asymmetry was the gap, not the reach: `adb shell input tap` has always been
 * available through `run_command`.
 *
 * WHY TWO TOOLS, MIRRORING THE BROWSER. Reading is free and repeatable, acting
 * changes state — the same seam, and deliberately the same shape, so a model
 * that knows one knows the other. `mobile_inspect` reads (hierarchy / screenshot
 * / logs); `mobile` acts (tap / type / key / swipe / launch), by `ref`.
 *
 * WHAT IT IS NOT. Not a device manager, not an install pipeline, not a log
 * streamer. Booting emulators, installing APKs and tailing logs all work through
 * `run_command` today, and wrapping them would be surface without capability —
 * the thing this release spent its budget removing. The wrapper earns its tokens
 * only where it adds something `run_command` cannot: refs.
 *
 * PARITY IS ASYMMETRIC AND SAYS SO. `simctl` screenshots, streams logs and
 * launches; it has no hierarchy dump and no input injection (those need `idb`).
 * The iOS paths return the named limitation, not a generic failure, because an
 * agent told "not supported" stops and an agent told "failed" retries.
 */

import { ToolRegistry } from "./registry";
import {
  runDeviceCli,
  quoteForDeviceShell,
  isValidPackageId,
  ensureTapFeedback,
  captureSimulatorScreenshot,
  iosLogPredicate,
  IOS_LOG_WINDOW,
} from "@/lib/mobile/device-tools";
import { resolveDevice, type MobileDevice, iosGap } from "@/lib/mobile/devices";
import {
  parseUiHierarchy,
  formatUiHierarchy,
  findUiElements,
  type MobileElement,
} from "@/lib/mobile/ui-hierarchy";

type Args = Record<string, unknown>;
const str = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim() : "");
const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : undefined);

/** Pull the current hierarchy. Android only. */
async function readHierarchy(
  device: MobileDevice,
): Promise<{ ok: true; xml: string } | { ok: false; error: string }> {
  const gap = iosGap(device, "hierarchy");
  if (gap) return { ok: false, error: gap };
  // `uiautomator dump /dev/tty` writes the XML to stdout, avoiding a
  // pull-then-delete round trip through the device's filesystem.
  const r = await runDeviceCli(
    "adb",
    ["-s", device.id, "shell", "uiautomator", "dump", "/dev/tty"],
    { timeoutMs: 25_000 },
  );
  if (!r.ok) return { ok: false, error: r.error };
  const start = r.stdout.indexOf("<");
  if (start < 0) {
    return {
      ok: false,
      error:
        "uiautomator returned no XML. The screen may be mid-transition — retry once; " +
        "if it persists the foreground app draws its own surface and only " +
        'mode:"screenshot" can see it.',
    };
  }
  return { ok: true, xml: r.stdout.slice(start) };
}

/**
 * Resolve a ref to a point against the CURRENT screen.
 *
 * Re-dumped per act rather than cached from the last read, because a ref that
 * survived a screen change is precisely the bug refs exist to prevent: the index
 * still resolves, to a different element.
 */
async function resolveRef(
  device: MobileDevice,
  ref: string,
): Promise<{ ok: true; element: MobileElement } | { ok: false; error: string }> {
  const h = await readHierarchy(device);
  if (!h.ok) return h;
  const { elements } = parseUiHierarchy(h.xml, { interactiveOnly: false, max: 500 });
  const hit = elements.find((e) => e.ref === ref);
  if (!hit) {
    return {
      ok: false,
      error:
        `No element "${ref}" on the current screen. Refs are valid for one screen only — ` +
        `re-read with mobile_inspect and use a fresh ref.`,
    };
  }
  return { ok: true, element: hit };
}

// ── mobile_inspect ─────────────────────────────────────────────────────────

ToolRegistry.register({
  name: "mobile_inspect",
  requiresWorkspace: false,
  isCore: false,
  isReadOnly: true,
  allowInAskMode: true,
  description:
    // THE FIRST SENTENCE IS LOAD-BEARING. This tool is peripheral under
    // tool-reveal in both modes that offer it, so a Build turn binds this
    // sentence plus a `tool_help` pointer and nothing else. It therefore has to
    // carry the cheap default (a TEXT hierarchy) — not an introduction. Making
    // the default the cheap path is also why this tool needs no NEVER_TRIM
    // entry: a model that calls it with no arguments gets the right read.
    "Read the screen of a running Android emulator or iOS Simulator as TEXT: called with no `mode` it returns the UI hierarchy — every interactive element with a stable `ref` for the `mobile` tool to act on — which answers \"what is on screen\", \"is the button there\" and \"did the form submit\" in a few hundred tokens.\n" +
    "mode:\"screenshot\" — a literal PNG and a LAST RESORT (thousands of tokens): only when the user needs the actual image (a design to match, a rendering artefact, a custom-drawn surface). NEVER to answer \"what do you see\" or to find an element — the hierarchy already does that, in text.\n" +
    "mode:\"logs\" — a bounded tail of the device log, filtered to warnings and errors by default. This is where a crash's stack trace is.\n" +
    "mode:\"devices\" — what is running, when you need to name one.\n" +
    "iOS Simulator has NO hierarchy and NO input (a `simctl` limitation, not a transient failure): screenshots and logs work, refs and taps do not.",
  parameters: {
    type: "object",
    properties: {
      mode: {
        type: "string",
        enum: ["hierarchy", "screenshot", "logs", "devices"],
        description: "Default \"hierarchy\" (text, cheap). \"screenshot\" is a PNG and a last resort.",
      },
      device: {
        type: "string",
        description:
          "Which device (id or name, from mode:\"devices\"). Optional with one running; REQUIRED once several are.",
      },
      query: {
        type: "string",
        description: "With mode:\"hierarchy\", rank to the elements matching plain words (\"submit button\", \"email field\").",
      },
      lines: {
        type: "number",
        description: "With mode:\"logs\", how many recent lines (default 120, max 400).",
      },
      level: {
        type: "string",
        enum: ["error", "warn", "all"],
        description: "With mode:\"logs\", minimum level. Default \"warn\" (warnings and errors).",
      },
      package: {
        type: "string",
        description:
          "With mode:\"logs\", narrow to one app (Android package or iOS bundle id). Strongly recommended — a device log is the whole OS, and filtering is the difference between megabytes of system noise and your app's own errors.",
      },
    },
    required: [],
    additionalProperties: false,
  },
  handler: async (rawArgs: unknown) => {
    const args = (rawArgs ?? {}) as Args;
    const mode = str(args.mode) || "hierarchy";

    if (mode === "devices") {
      const { listMobileDevices, describeDevices } = await import("@/lib/mobile/devices");
      const devices = await listMobileDevices();
      return {
        success: true,
        devices,
        title: "Devices",
        content: devices.length
          ? `${devices.length} running: ${describeDevices(devices)}`
          : "Nothing running. Start an Android emulator or an iOS Simulator.",
      };
    }

    const resolved = await resolveDevice(str(args.device) || undefined);
    if (!resolved.ok) return { success: false, error: resolved.error };
    const device = resolved.device;

    if (mode === "screenshot") {
      // `adb exec-out screencap -p` genuinely streams to stdout. `simctl io …
      // screenshot -` does NOT — it writes a file called `-`. See
      // captureSimulatorScreenshot.
      const r =
        device.platform === "android"
          ? await runDeviceCli("adb", ["-s", device.id, "exec-out", "screencap", "-p"], {
              timeoutMs: 30_000,
              binary: true,
            })
          : await captureSimulatorScreenshot(device.id);
      if (!r.ok) return { success: false, error: r.error };
      if (r.buffer.length === 0) {
        return { success: false, error: "The capture came back empty. Is the screen on?" };
      }
      // Downscale, for the same reason browser_inspect does: a live iPhone 17
      // simulator screenshot measured 2.8 MB, which is ~3.8 MB of base64 and far
      // past anything worth sending. 1280 wide, aspect preserved.
      const shot = await (async () => {
        try {
          const { nativeImage } = await import("electron");
          const image = nativeImage.createFromBuffer(r.buffer);
          if (image.isEmpty()) return r.buffer;
          const { width } = image.getSize();
          return width > 1280 ? image.resize({ width: 1280 }).toPNG() : r.buffer;
        } catch {
          // Headless/Electron-free contexts: send what we captured rather than
          // failing over a size optimisation.
          return r.buffer;
        }
      })();
      // HARD GUARD, not just an optimisation. The downscale needs Electron's
      // nativeImage; if it is ever unavailable the `catch` above sends the raw
      // capture, and a live iPhone 17 screenshot is 2.85 MB — roughly 3.8 MB of
      // base64, which is not a payload, it is an outage. Refuse and point at the
      // read that answers the same question in a few hundred tokens.
      if (shot.length > 1_500_000) {
        return {
          success: false,
          error:
            `The screenshot is ${Math.round(shot.length / 1024)} KB, too large to send. ` +
            `Read the screen as TEXT instead (mobile_inspect with no mode) — it answers ` +
            `"what is on screen" for a fraction of the cost.`,
        };
      }
      // THE CONTRACT, not a convention: `{ success, mimeType: "image/*", data }`
      // at the top level is what `extractImageMedia` matches, and matching it
      // earns three behaviours with no further wiring — truncation exemption,
      // base64 redaction in the transcript, and the vision model part. The gate
      // is the SHAPE; `_toolName` in buildToolModelOutput is deliberately unused.
      return {
        success: true,
        mimeType: "image/png",
        data: shot.toString("base64"),
        device: device.label,
      };
    }

    if (mode === "logs") {
      const lines = Math.min(Math.max(num(args.lines) ?? 120, 10), 400);
      const level = str(args.level) || "warn";
      // VALIDATED HERE, ONCE, FOR BOTH PLATFORMS — found by the release security
      // review. The iOS branch interpolates this into an NSPredicate
      // (`process CONTAINS "…"`), and `.split(".").pop()` is not a sanitiser: a
      // payload with no dot passes through verbatim, `"` included. So
      // `x" OR message CONTAINS "password` widened a filter the tool then still
      // described as scoped to one app.
      //
      // Not shell injection — `execFile` takes an argv array — but NSPredicate is
      // an expression language, and this was the one place a model-relayed string
      // reached an interpreter unescaped. Validating rather than escaping, for the
      // same reason `action:"launch"` does: anything outside an identifier shape
      // is a mistake worth reporting, and `isValidPackageId` admits no `"`, `\`
      // or predicate operator.
      //
      // The ASYMMETRY was the actual defect: `launch` validated, Android's logs
      // quoted, and iOS's logs did neither. One check up front removes the
      // question.
      const pkgFilter = str(args.package);
      if (pkgFilter && !isValidPackageId(pkgFilter)) {
        return {
          success: false,
          error:
            `"${pkgFilter}" is not an app identifier. Expected something like ` +
            `com.example.app — letters, digits, dots, dashes and underscores only.`,
        };
      }
      if (device.platform === "android") {
        // `-d` dumps and exits; without it logcat streams forever and the tool
        // call hangs until its timeout.
        const spec = level === "all" ? "*:V" : level === "error" ? "*:E" : "*:W";
        // Same filter as iOS, by pid. `logcat -t N` already bounds the volume,
        // so this is about SIGNAL: without it the tail is mostly system chatter
        // and your app's stack trace may have scrolled past it.
        const pkg = pkgFilter;
        let pidFlag: string[] = [];
        if (pkg) {
          const pid = await runDeviceCli(
            "adb",
            ["-s", device.id, "shell", "pidof", "-s", quoteForDeviceShell(pkg)],
            { timeoutMs: 10_000 },
          );
          const found = pid.ok ? pid.stdout.trim().split(/\s+/)[0] : "";
          // Not running is a fact worth reporting, not a reason to silently
          // hand back the whole system log as if it were the app's.
          if (!/^\d+$/.test(found)) {
            return {
              success: true,
              device: device.label,
              title: `${device.label} — logs`,
              content:
                `"${pkg}" is not running on ${device.label}, so it has no log. ` +
                `Launch it with mobile({action:"launch", package}) first, or omit ` +
                `\`package\` to read the whole device log.`,
            };
          }
          pidFlag = [`--pid=${found}`];
        }
        const r = await runDeviceCli(
          "adb",
          ["-s", device.id, "logcat", "-d", "-t", String(lines), ...pidFlag, spec],
          { timeoutMs: 25_000 },
        );
        if (!r.ok) return { success: false, error: r.error };
        const text = r.stdout.trim();
        return {
          success: true,
          device: device.label,
          title: `${device.label} — logs`,
          content:
            text ||
            `No ${level}-level entries in the last ${lines} lines` +
              (pkg ? ` for "${pkg}"` : "") + ".",
        };
      }
      // A simulator's log is the WHOLE OS, not your app: 3.2 MB over 2 minutes
      // even filtered to errors, against 3.5 KB with a process filter. So the
      // window is bounded and `package` is worth passing.
      const proc = pkgFilter;
      const filter = proc
        ? [
            "--predicate",
            `process CONTAINS "${proc.split(".").pop() ?? proc}"` +
              (level === "all" ? "" : ' AND (messageType == "Error" OR messageType == "Fault")'),
          ]
        : iosLogPredicate(level);
      const r = await runDeviceCli(
        "xcrun",
        [
          "simctl",
          "spawn",
          device.id,
          "log",
          "show",
          "--last",
          IOS_LOG_WINDOW,
          "--style",
          "compact",
          ...filter,
        ],
        { timeoutMs: 40_000 },
      );
      if (!r.ok) return { success: false, error: r.error };
      const tail = r.stdout.trim().split(/\r?\n/).slice(-lines).join("\n");
      return {
        success: true,
        device: device.label,
        title: `${device.label} — logs`,
        content:
          tail ||
          `No ${level}-level entries in the last ${IOS_LOG_WINDOW} on ${device.label}.` +
            (proc ? ` (filtered to process "${proc}")` : ""),
      };
    }

    // hierarchy (default)
    const h = await readHierarchy(device);
    if (!h.ok) return { success: false, error: h.error };
    const parsed = parseUiHierarchy(h.xml);
    const query = str(args.query);
    if (query) {
      const hits = findUiElements(parsed.elements, query);
      if (hits.length === 0) {
        return {
          success: true,
          device: device.label,
          title: device.label,
          content:
            `Nothing matched "${query}" among ${parsed.total} elements. ` +
            `Read without \`query\` to see the whole screen, or scroll — the element may be off-screen.`,
        };
      }
      return {
        success: true,
        device: device.label,
        title: device.label,
        content: formatUiHierarchy({ elements: hits, total: hits.length }, device),
      };
    }
    return {
      success: true,
      device: device.label,
      title: device.label,
      content: formatUiHierarchy(parsed, device),
    };
  },
});

// ── mobile ─────────────────────────────────────────────────────────────────

ToolRegistry.register({
  name: "mobile",
  requiresWorkspace: false,
  isCore: false,
  // Mutates the DEVICE, never the workspace — the same argument that keeps
  // `browser` on the read-only surfaces. The mode allowlist is still the gate.
  isReadOnly: false,
  allowInAskMode: true,
  description:
    // Same reason as above: this sentence is the whole binding on a peripheral
    // turn, so it names the actions AND the ref requirement rather than
    // introducing the tool.
    "Act on a running Android emulator by element `ref` from mobile_inspect — action:\"tap\" / \"type\" / \"key\" / \"swipe\" / \"launch\" (there is no coordinate form).\n" +
    "action:\"tap\" — tap the element at `ref`.\n" +
    "action:\"type\" — focus `ref` and enter `text`.\n" +
    "action:\"key\" — press a device key via `key`: \"back\", \"home\", \"enter\", \"tab\", \"delete\", or \"recents\".\n" +
    "action:\"swipe\" — `direction` up/down/left/right to scroll the screen, or pass `ref` to swipe that element.\n" +
    "action:\"launch\" — start an app by `package` (Android) or bundle id (iOS).\n" +
    "Refs are valid for ONE screen: they are re-resolved against the live screen on every call, so a ref that has scrolled away fails loudly rather than tapping the wrong thing. There are no coordinates on purpose — a coordinate is correct for one screen size and wrong everywhere else, and it fails by succeeding on empty space.\n" +
    "iOS Simulator has no input injection (a `simctl` limitation): only action:\"launch\" works there.",
  parameters: {
    type: "object",
    properties: {
      action: {
        type: "string",
        enum: ["tap", "type", "key", "swipe", "launch"],
      },
      ref: { type: "string", description: "Element ref from mobile_inspect (e.g. \"m3\")." },
      text: { type: "string", description: "With action:\"type\", what to enter." },
      key: {
        type: "string",
        enum: ["back", "home", "enter", "tab", "delete", "recents"],
      },
      direction: {
        type: "string",
        enum: ["up", "down", "left", "right"],
        description: "With action:\"swipe\". \"down\" reveals content further down the screen.",
      },
      package: { type: "string", description: "With action:\"launch\": Android package or iOS bundle id." },
      device: {
        type: "string",
        description: "Optional with one device running; REQUIRED once several are.",
      },
    },
    required: ["action"],
    additionalProperties: false,
  },
  handler: async (rawArgs: unknown) => {
    const args = (rawArgs ?? {}) as Args;
    const action = str(args.action);
    if (!action) {
      return {
        success: false,
        error: "mobile needs an `action`: tap, type, key, swipe, or launch.",
      };
    }

    const resolved = await resolveDevice(str(args.device) || undefined);
    if (!resolved.ok) return { success: false, error: resolved.error };
    const device = resolved.device;

    if (action === "launch") {
      const pkg = str(args.package);
      if (!pkg) {
        return { success: false, error: 'action:"launch" needs `package` (Android package or iOS bundle id).' };
      }
      if (!isValidPackageId(pkg)) {
        return {
          success: false,
          error:
            `"${pkg}" is not a package identifier. Expected something like ` +
            `com.example.app — letters, digits, dots, dashes and underscores only.`,
        };
      }
      const r =
        device.platform === "android"
          ? await runDeviceCli(
              "adb",
              ["-s", device.id, "shell", "monkey", "-p", pkg, "-c", "android.intent.category.LAUNCHER", "1"],
              { timeoutMs: 25_000 },
            )
          : await runDeviceCli("xcrun", ["simctl", "launch", device.id, pkg], {
              timeoutMs: 25_000,
            });
      if (!r.ok) return { success: false, error: r.error };
      return {
        success: true,
        device: device.label,
        title: device.label,
        content: `Launched ${pkg}. Read the screen with mobile_inspect — it takes a moment to draw.`,
      };
    }

    const gap = iosGap(device, "input");
    if (gap) return { success: false, error: gap };

    // Make the taps watchable. Once per device per process, on the first ACT
    // only — a read must never change the screen it is reading. Returns a note
    // the first time so the activity row can say it happened; null after, and
    // null on any failure, because a visual nicety must not fail a tap.
    const feedbackNote = await ensureTapFeedback(device.id, device.label);
    const withNote = (content: string) =>
      feedbackNote ? `${content}\n${feedbackNote}` : content;

    if (action === "key") {
      const map: Record<string, string> = {
        back: "KEYCODE_BACK",
        home: "KEYCODE_HOME",
        enter: "KEYCODE_ENTER",
        tab: "KEYCODE_TAB",
        delete: "KEYCODE_DEL",
        recents: "KEYCODE_APP_SWITCH",
      };
      const code = map[str(args.key)];
      if (!code) {
        return {
          success: false,
          error: `Unknown key "${str(args.key)}". Use back, home, enter, tab, delete, or recents.`,
        };
      }
      const r = await runDeviceCli(
        "adb",
        ["-s", device.id, "shell", "input", "keyevent", code],
        { timeoutMs: 15_000 },
      );
      if (!r.ok) return { success: false, error: r.error };
      return {
        success: true,
        device: device.label,
        title: device.label,
        content: withNote(`Pressed ${str(args.key)}.`),
      };
    }

    if (action === "swipe" && !str(args.ref)) {
      // A screen-relative swipe needs the screen size, which varies per device —
      // so read it rather than assuming a phone.
      const size = await runDeviceCli("adb", ["-s", device.id, "shell", "wm", "size"], {
        timeoutMs: 10_000,
      });
      const m = size.ok ? size.stdout.match(/(\d+)x(\d+)/) : null;
      const w = m ? Number(m[1]) : 1080;
      const h = m ? Number(m[2]) : 1920;
      const cx = Math.round(w / 2);
      const cy = Math.round(h / 2);
      const dy = Math.round(h * 0.3);
      const dx = Math.round(w * 0.3);
      const dir = str(args.direction) || "down";
      // "down" means "show me what is below", which is an UPWARD finger motion.
      const path: Record<string, [number, number, number, number]> = {
        down: [cx, cy + dy, cx, cy - dy],
        up: [cx, cy - dy, cx, cy + dy],
        left: [cx + dx, cy, cx - dx, cy],
        right: [cx - dx, cy, cx + dx, cy],
      };
      const p = path[dir];
      if (!p) {
        return { success: false, error: `Unknown direction "${dir}". Use up, down, left, or right.` };
      }
      const r = await runDeviceCli(
        "adb",
        ["-s", device.id, "shell", "input", "swipe", ...p.map(String), "300"],
        { timeoutMs: 15_000 },
      );
      if (!r.ok) return { success: false, error: r.error };
      return {
        success: true,
        device: device.label,
        title: device.label,
        content: withNote(`Swiped ${dir}. Re-read the screen — refs from before this call are stale.`),
      };
    }

    const ref = str(args.ref);
    if (!ref) {
      return {
        success: false,
        error: `action:"${action}" needs a \`ref\` from mobile_inspect. There is no coordinate form.`,
      };
    }
    const el = await resolveRef(device, ref);
    if (!el.ok) return { success: false, error: el.error };
    const { x, y } = el.element.center;
    const label = el.element.name || el.element.role;

    if (action === "tap") {
      const r = await runDeviceCli(
        "adb",
        ["-s", device.id, "shell", "input", "tap", String(x), String(y)],
        { timeoutMs: 15_000 },
      );
      if (!r.ok) return { success: false, error: r.error };
      return {
        success: true,
        device: device.label,
        title: device.label,
        content: withNote(`Tapped ${label}. Re-read the screen if this navigated.`),
      };
    }

    if (action === "type") {
      const text = str(args.text);
      if (!text) return { success: false, error: 'action:"type" needs `text`.' };
      const tap = await runDeviceCli(
        "adb",
        ["-s", device.id, "shell", "input", "tap", String(x), String(y)],
        { timeoutMs: 15_000 },
      );
      if (!tap.ok) return { success: false, error: tap.error };
      // Quoted for the DEVICE's shell — `adb shell` joins its args and runs them
      // through `sh -c` on the far side, so an unquoted `;` in text the agent
      // READ somewhere would execute there. See quoteForDeviceShell.
      const r = await runDeviceCli(
        "adb",
        ["-s", device.id, "shell", "input", "text", quoteForDeviceShell(text)],
        { timeoutMs: 20_000 },
      );
      if (!r.ok) return { success: false, error: r.error };
      return {
        success: true,
        device: device.label,
        title: device.label,
        content: withNote(`Typed into ${label}.`),
      };
    }

    // swipe on a specific element
    const r = await runDeviceCli(
      "adb",
      [
        "-s",
        device.id,
        "shell",
        "input",
        "swipe",
        String(x),
        String(y),
        String(x),
        String(Math.max(0, y - 400)),
        "300",
      ],
      { timeoutMs: 15_000 },
    );
    if (!r.ok) return { success: false, error: r.error };
    return {
      success: true,
      device: device.label,
      title: device.label,
      content: withNote(`Swiped ${label}.`),
    };
  },
});
