/**
 * Which app are we talking to — and the one that is never an answer.
 *
 * # ATLARIX IS NEVER A TARGET
 *
 * Every other application on the machine is fair game (owner's decision: any and
 * all apps, no per-app prompt). Atlarix itself is not, and this is the check the
 * rest of the app's safety rests on: **a tool that can click Atlarix's own approval
 * buttons invalidates every gate in the product.** File-write approvals, command
 * approvals, the danger prompt — all of them become a button the agent can press
 * itself.
 *
 * THREE INDEPENDENT CHECKS, because one is not enough:
 *
 *  1. **PID** against `app.getAppMetrics()`, which enumerates every process we own
 *     — main, renderers, GPU, utility — not just `process.pid`. A renderer's pid is
 *     what `list_apps` would report for a window.
 *  2. **Identity** — bundle id, process name and window owner against `app.getName()`
 *     and the packaged bundle id. Catches a dev build whose pid the metrics call
 *     missed, and a second copy of Atlarix running from another path.
 *  3. **Exclusion from the listing.** `list_apps` filters Atlarix out entirely, so
 *     the model never learns a name or a pid for it.
 *
 * The third matters most and is the one that is easy to leave out. Refusing only at
 * act time leaves a discoverable target: the model sees Atlarix in the list, forms
 * a plan around it, and burns turns being refused. Making it invisible means the
 * attempt never forms.
 */
import { app } from "electron";
import log from "electron-log";
import { callDriver } from "./driver-session";
import { guardTargetApp } from "./guards";

const logger = log.scope("computer-use");

export interface DesktopApp {
  name: string;
  pid: number;
  bundleId?: string;
  running: boolean;
  active: boolean;
  windows: Array<{ id?: string; title?: string }>;
}

/** Every pid this Electron app owns. */
function ownPids(): Set<number> {
  const pids = new Set<number>([process.pid]);
  try {
    for (const m of app.getAppMetrics()) {
      if (typeof m.pid === "number") pids.add(m.pid);
    }
  } catch {
    // Outside Electron (tests): process.pid alone is the best we can do, and the
    // identity check below is the real backstop anyway.
  }
  try {
    if (typeof process.ppid === "number") pids.add(process.ppid);
  } catch {
    /* ignore */
  }
  return pids;
}

/** Names and ids that mean "this is us". */
function ownIdentities(): string[] {
  const out = ["atlarix", "com.electron.atlarix"];
  try {
    const n = app.getName?.();
    if (n) out.push(n.toLowerCase());
  } catch {
    /* ignore */
  }
  return [...new Set(out.filter(Boolean))];
}

export function isSelf(candidate: { name?: string; pid?: number; bundleId?: string }): boolean {
  if (typeof candidate.pid === "number" && ownPids().has(candidate.pid)) return true;
  const hay = `${candidate.name ?? ""} ${candidate.bundleId ?? ""}`.toLowerCase();
  return ownIdentities().some((id) => hay.includes(id));
}

/** The refusal, in permanent-policy wording so the model stops rather than probing. */
export function selfTargetRefusal(): string {
  return (
    "That is Atlarix's own window. Atlarix will not read or control itself — that would " +
    "let this turn click its own approval buttons, which is what every other safety gate " +
    "in the app depends on. Do not retry — pick a different application, or do the work " +
    "with your ordinary tools."
  );
}

interface DriverApp {
  name?: string;
  pid?: number;
  bundle_id?: string;
  running?: boolean;
  active?: boolean;
  windows?: Array<{ id?: string; window_id?: string; title?: string }>;
}

/**
 * List running applications, Atlarix excluded.
 *
 * `list_apps` needs no TCC grant — verified live: it returned a full list with
 * `accessibility: false` and `screen_recording: false`. So this is the one read that
 * works before the user has granted anything, which makes it the right first call
 * for a model orienting itself.
 */
export async function listApps(): Promise<DesktopApp[]> {
  const raw = (await callDriver("list_apps", {})) as { apps?: DriverApp[] };
  const apps = raw?.apps ?? [];
  const out: DesktopApp[] = [];
  for (const a of apps) {
    if (!a.name || typeof a.pid !== "number") continue;
    if (!a.running) continue;
    // CHECK 3: never listed. See the header.
    if (isSelf({ name: a.name, pid: a.pid, bundleId: a.bundle_id })) continue;
    out.push({
      name: a.name,
      pid: a.pid,
      ...(a.bundle_id ? { bundleId: a.bundle_id } : {}),
      running: true,
      active: Boolean(a.active),
      windows: (a.windows ?? []).map((w) => ({
        ...(w.id ?? w.window_id ? { id: String(w.id ?? w.window_id) } : {}),
        ...(w.title ? { title: w.title } : {}),
      })),
    });
  }
  return out;
}

/**
 * CHECK 3, ON THE WAY OUT — for the tools that answer without being asked about an
 * app at all.
 *
 * `listApps()` above filters Atlarix from `list_apps`, and until `computer_call`
 * existed that was the whole of check 3, because `list_apps` was the only listing
 * the model could reach. It no longer is, and the two new ways round it were found
 * by reading the driver's own `describe` output rather than by reasoning about the
 * names:
 *
 *   - `list_windows` — `pid` is OPTIONAL. With no pid it returns every layer-0
 *     window WindowServer knows about, each with `pid`, `app_name`, `title` and
 *     `bounds`. There is no app to resolve, so `resolveTargetPid` is never reached.
 *   - `get_accessibility_tree` — takes NO PARAMETERS AT ALL, and its own description
 *     is *"running regular apps and on-screen visible windows with their bounds,
 *     z-order, and owner pid ... a fast discovery read that needs no TCC grants"*.
 *     So it is a complete substitute for `list_apps`, it needs no permission, and it
 *     has no input for an inbound guard to inspect.
 *
 * Both would hand the model Atlarix's pid, window title and on-screen bounds — the
 * three things needed to aim at our own approval buttons. An inbound guard cannot
 * help with either, so the filter has to run on the RESULT.
 *
 * It walks rather than reading fixed keys: the exact nesting is the driver's to
 * change on a pin bump, and a filter that silently stops matching a renamed field is
 * the failure mode this whole file exists to avoid.
 */
const SELF_FILTERED_TOOLS: ReadonlySet<string> = new Set([
  "list_apps",
  "list_windows",
  "get_accessibility_tree",
]);

export function isSelfFilteredTool(tool: string): boolean {
  return SELF_FILTERED_TOOLS.has(tool);
}

/** Does this object look like an app or window record naming a process? */
function selfRecord(o: Record<string, unknown>): boolean {
  const pidRaw = o.pid ?? o.owner_pid ?? o.ownerPid ?? o.process_id;
  const pid = typeof pidRaw === "number" ? pidRaw : undefined;
  const name = [o.name, o.app_name, o.appName, o.owner_name, o.ownerName]
    .filter((v) => typeof v === "string")
    .join(" ");
  const bundleId = [o.bundle_id, o.bundleId].find((v) => typeof v === "string") as
    | string
    | undefined;
  if (pid === undefined && !name && !bundleId) return false;
  return isSelf({
    ...(pid !== undefined ? { pid } : {}),
    ...(name ? { name } : {}),
    ...(bundleId ? { bundleId } : {}),
  });
}

/**
 * Remove every record that names Atlarix from a driver result.
 *
 * Depth-bounded: these are flat listings, and an unbounded walk over an untrusted
 * shape is how a cycle becomes a hang.
 */
export function stripSelfFromResult(tool: string, result: unknown): unknown {
  if (!SELF_FILTERED_TOOLS.has(tool)) return result;
  const walk = (node: unknown, depth: number): unknown => {
    if (depth > 8 || node === null || typeof node !== "object") return node;
    if (Array.isArray(node)) {
      return node
        .filter((el) => !(el && typeof el === "object" && !Array.isArray(el) &&
          selfRecord(el as Record<string, unknown>)))
        .map((el) => walk(el, depth + 1));
    }
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(node as Record<string, unknown>)) {
      out[k] = walk(v, depth + 1);
    }
    return out;
  };
  return walk(result, 0);
}

export type ResolvedApp =
  | { ok: true; app: DesktopApp }
  | { ok: false; error: string };

/**
 * Resolve what the model named to one running application.
 *
 * THE SINGLE SEAM. Self-targeting and the class guards are enforced here rather
 * than in each action, so read, act and list are covered by one check and a new
 * action cannot forget it.
 */
export async function resolveTargetApp(nameOrId: string): Promise<ResolvedApp> {
  const wanted = nameOrId.trim();
  if (!wanted) {
    return {
      ok: false,
      error:
        'computer_inspect needs an `app` (except with mode:"apps"). Call mode:"apps" first ' +
        "to see what is running.",
    };
  }

  // CHECK 1 + 2, before we even look at the list: a model that names Atlarix
  // explicitly gets the refusal, not a "no such app".
  if (isSelf({ name: wanted, bundleId: wanted })) {
    return { ok: false, error: selfTargetRefusal() };
  }

  const apps = await listApps();
  const needle = wanted.toLowerCase();
  const exact = apps.filter(
    (a) => a.name.toLowerCase() === needle || a.bundleId?.toLowerCase() === needle,
  );
  const partial = exact.length
    ? exact
    : apps.filter(
        (a) => a.name.toLowerCase().includes(needle) || a.bundleId?.toLowerCase().includes(needle),
      );

  if (partial.length === 0) {
    const running = apps
      .slice(0, 12)
      .map((a) => a.name)
      .join(", ");
    return {
      ok: false,
      error:
        `No running application matches "${wanted}". Running now: ${running || "(none listed)"}. ` +
        `Use mode:"apps" for the full list, and name one of those.`,
    };
  }
  if (partial.length > 1) {
    return {
      ok: false,
      error:
        `"${wanted}" matches ${partial.length} running applications ` +
        `(${partial.map((a) => a.name).join(", ")}). Name one exactly.`,
    };
  }

  return vetResolved(partial[0]!);
}

/**
 * THE SHARED TAIL. Everything that decides whether a RESOLVED app may be touched.
 *
 * Factored out because there are now two ways in — a name (`resolveTargetApp`) and a
 * raw pid (`resolveTargetPid`, which `computer_call` needs) — and two copies of a
 * containment check is how one of them silently stops matching the other. The header
 * calls this file "THE SINGLE SEAM"; that is only true while both entry points end
 * here.
 */
function vetResolved(target: DesktopApp): ResolvedApp {
  // CHECK 1 again, on the RESOLVED pid — an identity check on what the model typed
  // cannot see a pid the model never mentioned.
  if (isSelf({ name: target.name, pid: target.pid, bundleId: target.bundleId })) {
    return { ok: false, error: selfTargetRefusal() };
  }

  const guard = guardTargetApp({ name: target.name, bundleId: target.bundleId });
  if (!guard.allowed) {
    logger.info(`[computer-use] refused ${target.name}: class guard`);
    return { ok: false, error: guard.reason };
  }

  return { ok: true, app: target };
}

/**
 * Resolve a raw pid — the form `computer_call` hands us, and the form that has no
 * name for the guards to read.
 *
 * WHY THIS IS THE DANGEROUS DIRECTION. `resolveTargetApp` starts from a string, so
 * the self-check can fire on the string itself. A pid carries no name: the ONLY way
 * to learn that pid 4213 is Atlarix, or 1Password, or Terminal, is to look it up.
 * A dispatcher that passes `input.pid` straight to the driver therefore has no
 * guards at all — not weaker ones, none.
 *
 * Order matters here. `isSelf` runs BEFORE the listing, because `listApps()` filters
 * Atlarix out (check 3): looking up our own pid in that list finds nothing, and
 * "no running application has pid N" is the wrong answer — it invites a retry and it
 * lies about why.
 */
export async function resolveTargetPid(pid: unknown): Promise<ResolvedApp> {
  const n = typeof pid === "number" ? pid : Number(pid);
  if (!Number.isInteger(n) || n <= 0) {
    return {
      ok: false,
      error:
        `"${String(pid)}" is not a process id. Get one from computer_inspect mode:"apps", ` +
        `which lists what is running.`,
    };
  }

  if (isSelf({ pid: n })) return { ok: false, error: selfTargetRefusal() };

  const apps = await listApps();
  const found = apps.find((a) => a.pid === n);
  if (!found) {
    return {
      ok: false,
      error:
        `No running application has pid ${n}. Process ids change every launch — read ` +
        `computer_inspect mode:"apps" again and use a pid from that list.`,
    };
  }
  return vetResolved(found);
}
