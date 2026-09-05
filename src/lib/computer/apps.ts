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

  const target = partial[0]!;
  // CHECK 1 again, on the RESOLVED pid — the identity check above cannot see a pid
  // the model never mentioned.
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
