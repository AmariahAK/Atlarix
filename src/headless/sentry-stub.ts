/**
 * `@sentry/electron/main` for the terminal and the editors (aliased at build
 * time): a small crash reporter with the same calls, so the shared code that
 * reports through Sentry works unchanged. Before this the alias was a no-op
 * and the CLI, ACP and the VS Code panel's agent reported nothing.
 *
 * The same rule as the app: crash reports are separate from the analytics
 * answer (the consent text says so), carry stack traces and device facts, and
 * never code or prompts. In addition to the app's scrubber (expected errors
 * dropped, secrets redacted), the home folder, the working folder and email
 * addresses are taken out of every string before anything is sent.
 *
 * Sends nothing without a DSN, or when the host editor's own telemetry is off
 * (`ATLARIX_HOST_TELEMETRY=off`, set by the VS Code extension). At most
 * MAX_EVENTS per process, each distinct error once. No dependency: a Sentry
 * envelope over fetch.
 */
import os from "node:os";
import { randomUUID } from "node:crypto";
import { redactSecretsInText } from "@/lib/security/redact-secrets";

type Event = Record<string, unknown> & {
  message?: string;
  exception?: { values?: Array<{ type?: string; value?: string; stacktrace?: { frames?: Frame[] } }> };
};
type Frame = { filename?: string; function?: string; lineno?: number; colno?: number; in_app?: boolean };
type BeforeSend = (event: never, hint?: { originalException?: unknown }) => unknown;
interface InitOptions {
  dsn?: string;
  release?: string;
  environment?: string;
  beforeSend?: BeforeSend;
  /** Test seam: where envelopes go. */
  transport?: (url: string, init: RequestInit) => Promise<unknown>;
}

export const MAX_EVENTS = 10;

let options: InitOptions | null = null;
let sent = 0;
const seen = new Set<string>();
const inFlight = new Set<Promise<unknown>>();
const tags: Record<string, string> = {};

/** A DSN, or a stub on this machine for a live test (loopback only). */
function resolveDsn(dsn: string | undefined): string | undefined {
  const local = process.env.ATLARIX_SENTRY_DSN;
  if (local && /^http:\/\/[^@/]+@(127\.0\.0\.1|localhost)(:\d+)?\/\d+$/.test(local)) return local;
  return dsn || undefined;
}

function envelopeTarget(dsn: string): { url: string; key: string } | null {
  try {
    const u = new URL(dsn);
    const project = u.pathname.replace(/^\//, "");
    if (!u.username || !project) return null;
    return { url: `${u.protocol}//${u.host}/api/${project}/envelope/`, key: u.username };
  } catch {
    return null;
  }
}

function enabled(): boolean {
  return !!options?.dsn && process.env.ATLARIX_HOST_TELEMETRY !== "off";
}

export function init(opts: InitOptions = {}): void {
  options = { ...opts, dsn: resolveDsn(opts.dsn) };
}

const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Home folder → `~`, working folder → `<workspace>`, emails and secrets out. */
export function scrubText(text: string): string {
  let out = redactSecretsInText(text);
  const roots: Array<[string, string]> = [];
  try {
    const cwd = process.cwd();
    if (cwd && cwd !== "/" && cwd !== os.homedir()) roots.push([cwd, "<workspace>"]);
  } catch {
    /* no cwd */
  }
  const home = os.homedir();
  if (home && home !== "/") roots.push([home, "~"]);
  for (const [root, label] of roots) {
    // As written, and with Windows separators either way.
    for (const v of new Set([root, root.replace(/\\/g, "/"), root.replace(/\//g, "\\")])) {
      out = out.replace(new RegExp(escapeRe(v), "gi"), label);
    }
  }
  // A user name can still sit in a path the home folder did not cover (another drive).
  const user = (() => {
    try {
      return os.userInfo().username;
    } catch {
      return "";
    }
  })();
  if (user && user.length > 2) {
    out = out.replace(new RegExp(`([\\\\/])${escapeRe(user)}([\\\\/])`, "g"), "$1<user>$2");
  }
  return out.replace(EMAIL, "<email>");
}

function scrubDeep<T>(v: T): T {
  if (typeof v === "string") return scrubText(v) as T;
  if (Array.isArray(v)) return v.map(scrubDeep) as T;
  if (v && typeof v === "object") {
    const o: Record<string, unknown> = {};
    for (const [k, x] of Object.entries(v)) o[k] = scrubDeep(x);
    return o as T;
  }
  return v;
}

function parseFrames(stack: string | undefined): Frame[] {
  if (!stack) return [];
  const frames: Frame[] = [];
  for (const line of stack.split("\n").slice(1, 40)) {
    const m = /^\s*at (?:(.+?) \()?(.+?):(\d+):(\d+)\)?$/.exec(line);
    if (!m) continue;
    frames.push({
      function: m[1] || "?",
      filename: m[2],
      lineno: Number(m[3]),
      colno: Number(m[4]),
      in_app: !/node_modules|node:internal|^internal\//.test(m[2] ?? ""),
    });
  }
  // Sentry wants the oldest call first.
  return frames.reverse();
}

function baseEvent(level: string): Event {
  return {
    event_id: randomUUID().replace(/-/g, ""),
    timestamp: Date.now() / 1000,
    platform: "node",
    level,
    release: options?.release,
    environment: options?.environment ?? "production",
    tags: {
      surface: process.env.ATLARIX_REPORT_SURFACE ?? process.env.ATLARIX_SURFACE ?? "cli",
      ...(process.env.ATLARIX_ACP_EDITOR ? { editor: process.env.ATLARIX_ACP_EDITOR } : {}),
      os: process.platform,
      arch: process.arch,
      ...tags,
    },
    contexts: { runtime: { name: process.versions.bun ? "bun" : "node", version: process.versions.bun ?? process.version } },
  };
}

function fingerprint(e: Event): string {
  const ex = e.exception?.values?.[0];
  const top = ex?.stacktrace?.frames?.at(-1);
  return `${ex?.type ?? ""}|${(ex?.value ?? e.message ?? "").slice(0, 80)}|${top?.filename ?? ""}:${top?.lineno ?? ""}`;
}

function send(raw: Event, hint: { originalException?: unknown }): string {
  if (!enabled() || sent >= MAX_EVENTS) return "";
  let event: Event | null = raw;
  try {
    if (options?.beforeSend) event = options.beforeSend(raw as never, hint) as Event | null;
  } catch {
    /* a failing filter must not stop the report */
  }
  if (!event) return "";
  event = scrubDeep(event);
  const key = fingerprint(event);
  if (seen.has(key)) return "";
  seen.add(key);
  const target = envelopeTarget(options!.dsn!);
  if (!target) return "";
  sent++;
  const body = [
    JSON.stringify({ event_id: event.event_id, sent_at: new Date().toISOString() }),
    JSON.stringify({ type: "event" }),
    JSON.stringify(event),
  ].join("\n");
  const transport = options?.transport ?? ((url: string, init: RequestInit) => fetch(url, init));
  const p = transport(target.url, {
    method: "POST",
    headers: {
      "content-type": "application/x-sentry-envelope",
      "x-sentry-auth": `Sentry sentry_version=7, sentry_key=${target.key}, sentry_client=atlarix-cli/1`,
    },
    body,
  })
    .catch(() => {})
    .finally(() => inFlight.delete(p));
  inFlight.add(p);
  return String(event.event_id);
}

export function captureException(error: unknown, ctx?: { tags?: Record<string, string>; extra?: unknown }): string {
  try {
    const e = baseEvent("error");
    const err = error instanceof Error ? error : new Error(String(error));
    e.exception = {
      values: [{ type: err.name || "Error", value: err.message, stacktrace: { frames: parseFrames(err.stack) } }],
    };
    if (ctx?.tags) e.tags = { ...(e.tags as Record<string, string>), ...ctx.tags };
    return send(e, { originalException: error });
  } catch {
    return "";
  }
}

export function captureMessage(message: string, ctx?: unknown): string {
  try {
    const e = baseEvent(typeof ctx === "string" ? ctx : "info");
    e.message = message;
    return send(e, { originalException: message });
  } catch {
    return "";
  }
}

// Breadcrumbs, users and context are not kept: less to scrub, nothing to leak.
export const addBreadcrumb = (): void => {};
export const setUser = (): void => {};
export const setContext = (): void => {};
export function setTag(key: string, value: string): void {
  tags[key] = value;
}

/** Wait for what is being sent, at most `timeoutMs`. */
export async function flush(timeoutMs = 2000): Promise<boolean> {
  if (inFlight.size === 0) return true;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const done = await Promise.race([
    Promise.allSettled([...inFlight]).then(() => true),
    new Promise<boolean>((r) => {
      timer = setTimeout(() => r(false), timeoutMs);
    }),
  ]);
  if (timer) clearTimeout(timer);
  return done;
}

/** Test seam. */
export function __resetForTests(): void {
  options = null;
  sent = 0;
  seen.clear();
  inFlight.clear();
  for (const k of Object.keys(tags)) delete tags[k];
}

export default {
  init,
  captureException,
  captureMessage,
  addBreadcrumb,
  setUser,
  setTag,
  setContext,
  flush,
};
