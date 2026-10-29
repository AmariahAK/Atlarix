/**
 * Mods: a plugin's JavaScript module, run in a QuickJS (WASM) isolate.
 *
 * The isolate is the boundary. It has no Node, no DOM, no file system and no
 * network; the only way out is `$`, which the prelude (mod-prelude.ts) turns into
 * one host function taking and returning JSON strings. Every `$` call is checked
 * here against the capabilities the mod DECLARED in its manifest — the ones the
 * person saw at the second confirm — and bounded in size.
 *
 * Limits: a memory cap on the runtime and a CPU deadline on every call into it
 * (loading, each event). A mod that hits either is turned off for the rest of
 * this process and says so once; it is not retried. A mod that merely throws
 * loses that one event, as a hook that fails does.
 *
 * A mod is loaded only from a plugin that verifies on this load (registry.ts),
 * and its instance is keyed by the plugin's file hashes: an approved update gets
 * a fresh isolate, never the old one.
 *
 * The module: `export function register(on, $) { … }` (an ES module). The
 * mod-facing API is documented in `docs/mods.md`.
 */

import { EventEmitter } from "node:events";
import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import log from "electron-log";
import {
  newQuickJSWASMModuleFromVariant,
  newVariant,
  shouldInterruptAfterDeadline,
  type QuickJSContext,
  type QuickJSHandle,
  type QuickJSRuntime,
  type QuickJSWASMModule,
} from "quickjs-emscripten-core";
import releaseSyncVariant from "@jitl/quickjs-wasmfile-release-sync";
import { atlarixHomeDir } from "@/paths/atlarix-home";
import { realTarget } from "./control-guard";
import type { ModCapability } from "./manifest";
import { MOD_PRELUDE } from "./mod-prelude";
import { loadPlugins, type ActivePlugin } from "./registry";
import { sha256 } from "./tree-hash";

const logger = log.scope("mods");

export const MOD_MEMORY_LIMIT_BYTES = 32 * 1024 * 1024;
export const MOD_STACK_LIMIT_BYTES = 1024 * 1024;
/** Loading and `register` (once per isolate). */
export const MOD_LOAD_DEADLINE_MS = 1000;
/** Each event. `tool.call` runs before every tool, so this is on the hot path. */
export const MOD_EVENT_DEADLINE_MS = 200;

const STATUS_MAX = 200;
const TOAST_MAX = 300;
const SECTION_MAX = 4000;
const SECTIONS_PER_MOD = 5;
const PROMPT_MAX = 100_000;
const STORE_MAX_BYTES = 64 * 1024;
const FS_READ_MAX_BYTES = 256 * 1024;
const TREE_MAX_BYTES = 64 * 1024;

export const MOD_EVENTS = [
  "session.start",
  "tool.call",
  "prompt.submit",
  "prompt.compose",
  "command.run",
  "ui.render",
  "ui.action",
] as const;
export type ModEvent = (typeof MOD_EVENTS)[number];

/** What each event needs declared; `session.start` needs nothing. */
const EVENT_CAPABILITY: Readonly<Record<ModEvent, ModCapability | null>> = {
  "session.start": null,
  "tool.call": "tool",
  "prompt.submit": "prompt",
  "prompt.compose": "prompt",
  "command.run": "command",
  "ui.render": "ui",
  "ui.action": "ui",
};

const OP_CAPABILITY: Readonly<Record<string, ModCapability | null>> = {
  "ui.status": "ui",
  "ui.toast": "ui",
  "ui.open": "ui",
  "ui.close": "ui",
  "command.register": "command",
  "state.get": "state",
  "state.set": "state",
  "store.get": "state",
  "store.set": "state",
  "fs.read": "fs",
  log: null,
};

/** What surfaces draw: status line, toast, panes, and the mod's commands. */
export type ModUiEvent =
  | { kind: "status"; plugin: string; text: string | null }
  | { kind: "toast"; plugin: string; text: string }
  | { kind: "open"; plugin: string; id: string; title: string }
  | { kind: "close"; plugin: string; id: string }
  | { kind: "commands"; plugin: string }
  | { kind: "off"; plugin: string; reason: string };

export const modUiEvents = new EventEmitter();

export interface ModContext {
  workspacePath?: string | null;
  sessionId?: string;
}

export interface ModCommand {
  plugin: string;
  name: string;
  description: string;
}

interface ModInstance {
  plugin: string;
  digest: string;
  caps: ReadonlySet<ModCapability>;
  runtime: QuickJSRuntime;
  vm: QuickJSContext;
  commands: ModCommand[];
  panes: Map<string, string>;
  /** The context of the call in progress, for `fs.read` and `state`. */
  ctx: ModContext;
}

let quickjs: Promise<QuickJSWASMModule> | null = null;
const instances = new Map<string, ModInstance>();
/** Mods turned off for this process, and why. Never retried. */
const turnedOff = new Map<string, string>();
const sessionState = new Map<string, unknown>();

/**
 * The engine's WASM, handed to QuickJS as bytes rather than found by the
 * package itself: bundlers move the package's JS away from its .wasm, so its own
 * lookup works in development and fails once built. Where each build keeps it:
 * the compiled CLI embeds it (ATLARIX_QUICKJS_WASM, scripts/bun-cli-plugin.ts),
 * the headless bundle ships it beside itself (assets-node.ts), the packaged app
 * in Resources (forge extraResource), and development uses node_modules.
 * `plugins-mods-packaging.test.ts` fails if a build stops carrying it.
 */
export function quickjsWasmPath(): string | null {
  const candidates = [
    process.env.ATLARIX_QUICKJS_WASM,
    process.resourcesPath
      ? path.join(process.resourcesPath, "emscripten-module.wasm")
      : undefined,
    path.join(
      process.cwd(),
      "node_modules/@jitl/quickjs-wasmfile-release-sync/dist/emscripten-module.wasm",
    ),
  ];
  try {
    candidates.push(
      createRequire(import.meta.url).resolve(
        "@jitl/quickjs-wasmfile-release-sync/wasm",
      ),
    );
  } catch {
    // not resolvable from a bundle
  }
  return candidates.find((p): p is string => !!p && fs.existsSync(p)) ?? null;
}

function quickJS(): Promise<QuickJSWASMModule> {
  quickjs ??= (async () => {
    const wasm = quickjsWasmPath();
    if (!wasm) throw new Error("the QuickJS engine is missing from this build");
    const bytes = fs.readFileSync(wasm);
    return newQuickJSWASMModuleFromVariant(
      newVariant(releaseSyncVariant, {
        wasmBinary: bytes.buffer.slice(
          bytes.byteOffset,
          bytes.byteOffset + bytes.byteLength,
        ) as ArrayBuffer,
      }),
    );
  })();
  return quickjs;
}

function digestOf(p: ActivePlugin): string {
  return sha256(JSON.stringify(p.record.files));
}

class ModLimitError extends Error {}

/** Run `fn` with a CPU deadline; a hit is a limit, not an ordinary error. */
function withDeadline<T>(
  inst: Pick<ModInstance, "runtime">,
  ms: number,
  fn: () => T,
): T {
  inst.runtime.setInterruptHandler(
    shouldInterruptAfterDeadline(Date.now() + ms),
  );
  try {
    return fn();
  } finally {
    inst.runtime.removeInterruptHandler();
  }
}

/** A QuickJS error value → a JS Error; interrupts and OOM become ModLimitError. */
function failure(vm: QuickJSContext, handle: QuickJSHandle): Error {
  const dumped = vm.dump(handle) as
    | { name?: string; message?: string }
    | string;
  handle.dispose();
  const message =
    typeof dumped === "string"
      ? dumped
      : `${dumped?.name ?? "Error"}: ${dumped?.message ?? ""}`;
  if (
    /interrupted|out of memory|InternalError: stack overflow/i.test(message)
  ) {
    return new ModLimitError(message);
  }
  return new Error(message);
}

function turnOff(plugin: string, reason: string): void {
  if (turnedOff.has(plugin)) return;
  turnedOff.set(plugin, reason);
  const inst = instances.get(plugin);
  instances.delete(plugin);
  try {
    inst?.vm.dispose();
    inst?.runtime.dispose();
  } catch {
    // already gone
  }
  logger.warn(`mod ${plugin} turned off: ${reason}`);
  modUiEvents.emit("ui", { kind: "off", plugin, reason } satisfies ModUiEvent);
}

export function modProblems(): Array<{ name: string; message: string }> {
  return [...turnedOff].map(([name, reason]) => ({
    name,
    message: `${name}'s mod is off until Atlarix restarts: ${reason}`,
  }));
}

async function instanceFor(
  p: ActivePlugin,
  ctx: ModContext,
): Promise<ModInstance | null> {
  const name = p.contents.name;
  if (!p.contents.mod || turnedOff.has(name)) return null;
  const digest = digestOf(p);
  const existing = instances.get(name);
  if (existing && existing.digest === digest) {
    existing.ctx = ctx;
    return existing;
  }
  if (existing) {
    instances.delete(name);
    existing.vm.dispose();
    existing.runtime.dispose();
  }

  const source = fs.readFileSync(path.join(p.dir, p.contents.mod.main), "utf8");
  let engine: QuickJSWASMModule;
  try {
    engine = await quickJS();
  } catch (err) {
    quickjs = null;
    turnOff(name, (err as Error).message);
    return null;
  }
  const runtime = engine.newRuntime();
  runtime.setMemoryLimit(MOD_MEMORY_LIMIT_BYTES);
  runtime.setMaxStackSize(MOD_STACK_LIMIT_BYTES);
  // Modules may import only themselves: no file or package resolution at all.
  runtime.setModuleLoader((moduleName) => ({
    error: new Error(`mods cannot import "${moduleName}"`),
  }));
  const vm = runtime.newContext();
  const inst: ModInstance = {
    plugin: name,
    digest,
    caps: new Set(p.contents.mod.capabilities),
    runtime,
    vm,
    commands: [],
    panes: new Map(),
    ctx,
  };

  try {
    withDeadline(inst, MOD_LOAD_DEADLINE_MS, () => {
      const hostFn = vm.newFunction("__host", (opH, argsH) => {
        const op = vm.getString(opH);
        const args = vm.getString(argsH);
        return vm.newString(JSON.stringify(hostOp(inst, op, args)));
      });
      vm.setProp(vm.global, "__host", hostFn);
      hostFn.dispose();

      const prelude = vm.evalCode(MOD_PRELUDE, "atlarix:prelude");
      if (prelude.error) throw failure(vm, prelude.error);
      prelude.value.dispose();

      const mod = vm.evalCode(source, p.contents.mod!.main, { type: "module" });
      if (mod.error) throw failure(vm, mod.error);
      const register = vm.getProp(mod.value, "register");
      mod.value.dispose();
      if (vm.typeof(register) !== "function") {
        register.dispose();
        throw new Error("the mod exports no register(on, $)");
      }
      const reg = vm.getProp(vm.global, "__register");
      const done = vm.callFunction(reg, vm.undefined, register);
      reg.dispose();
      register.dispose();
      if (done.error) throw failure(vm, done.error);
      done.value.dispose();
    });
  } catch (err) {
    vm.dispose();
    runtime.dispose();
    if (err instanceof ModLimitError)
      turnOff(name, `it went over its limits while loading (${err.message})`);
    else turnOff(name, `it failed to load: ${(err as Error).message}`);
    return null;
  }
  instances.set(name, inst);
  return inst;
}

type HostResult = { value?: unknown } | { error: string };

function hostOp(inst: ModInstance, op: string, rawArgs: string): HostResult {
  if (!(op in OP_CAPABILITY)) return { error: `no such $ call: ${op}` };
  const need = OP_CAPABILITY[op];
  if (need && !inst.caps.has(need)) {
    return {
      error: `${op} needs the "${need}" capability, which this mod did not declare`,
    };
  }
  let args: Record<string, unknown>;
  try {
    args = (JSON.parse(rawArgs) ?? {}) as Record<string, unknown>;
  } catch {
    return { error: "bad arguments" };
  }
  const plugin = inst.plugin;
  const str = (v: unknown, max: number) => String(v ?? "").slice(0, max);
  switch (op) {
    case "log":
      logger.info(`[${plugin}] ${str(args.text, 1000)}`);
      return {};
    case "ui.status":
      emitUi({
        kind: "status",
        plugin,
        text: args.text == null ? null : str(args.text, STATUS_MAX),
      });
      return {};
    case "ui.toast":
      emitUi({ kind: "toast", plugin, text: str(args.text, TOAST_MAX) });
      return {};
    case "ui.open": {
      const id = str(args.id, 64);
      if (!id) return { error: "ui.open needs an id" };
      const title = str(args.title ?? id, 80);
      inst.panes.set(id, title);
      emitUi({ kind: "open", plugin, id, title });
      return {};
    }
    case "ui.close": {
      const id = str(args.id, 64);
      inst.panes.delete(id);
      emitUi({ kind: "close", plugin, id });
      return {};
    }
    case "command.register": {
      const name = str(args.name, 48).toLowerCase();
      if (!/^[a-z0-9][a-z0-9_-]*$/.test(name))
        return { error: "command names are a-z, 0-9, - and _" };
      if (!inst.commands.some((c) => c.name === name)) {
        inst.commands.push({
          plugin,
          name,
          description: str(args.description, 120),
        });
        emitUi({ kind: "commands", plugin });
      }
      return {};
    }
    case "state.get":
      return { value: sessionState.get(stateKey(inst, args.key)) ?? null };
    case "state.set": {
      const json = JSON.stringify(args.value ?? null);
      if (json.length > STORE_MAX_BYTES) return { error: "value too large" };
      sessionState.set(stateKey(inst, args.key), JSON.parse(json));
      return {};
    }
    case "store.get":
      return { value: readStore(plugin)[str(args.key, 200)] ?? null };
    case "store.set": {
      const store = readStore(plugin);
      store[str(args.key, 200)] = args.value ?? null;
      const json = JSON.stringify(store);
      if (json.length > STORE_MAX_BYTES)
        return { error: "the mod's store is full (64 KB)" };
      writeStore(plugin, json);
      return {};
    }
    case "fs.read":
      return readWorkspaceFile(inst.ctx.workspacePath, str(args.path, 1000));
  }
  return { error: `no such $ call: ${op}` };
}

function emitUi(e: ModUiEvent): void {
  modUiEvents.emit("ui", e);
}

function stateKey(inst: ModInstance, key: unknown): string {
  return `${inst.plugin}\u0000${inst.ctx.sessionId ?? ""}\u0000${String(key ?? "")}`;
}

/** `<atlarixHomeDir>/mod-store/<plugin>.json`: written by Atlarix for the mod, never by the mod. */
function storePath(plugin: string): string {
  return path.join(atlarixHomeDir(), "mod-store", `${plugin}.json`);
}

function readStore(plugin: string): Record<string, unknown> {
  try {
    const data = JSON.parse(fs.readFileSync(storePath(plugin), "utf8"));
    return data && typeof data === "object" && !Array.isArray(data) ? data : {};
  } catch {
    return {};
  }
}

function writeStore(plugin: string, json: string): void {
  const file = storePath(plugin);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, json, { mode: 0o600 });
  fs.renameSync(tmp, file);
}

/** Read-only, inside the open folder only (links resolved), bounded. */
function readWorkspaceFile(
  workspacePath: string | null | undefined,
  rel: string,
): HostResult {
  if (!workspacePath) return { error: "no folder is open" };
  const root = realTarget(workspacePath);
  const target = realTarget(path.resolve(workspacePath, rel));
  const inside = path.relative(root, target);
  if (!inside || inside.startsWith("..") || path.isAbsolute(inside)) {
    return { error: "fs.read reads files inside the open folder only" };
  }
  try {
    const st = fs.statSync(target);
    if (!st.isFile()) return { error: "not a file" };
    if (st.size > FS_READ_MAX_BYTES)
      return { error: "file too large for fs.read (256 KB)" };
    return { value: fs.readFileSync(target, "utf8") };
  } catch {
    return { error: "no such file" };
  }
}

function modsFor(ctx: ModContext): ActivePlugin[] {
  return loadPlugins(ctx.workspacePath ?? null).plugins.filter(
    (p) => !!p.contents.mod,
  );
}

/**
 * Deliver an event to every verified mod that declared what it needs, and
 * return each mod's answer. A mod that throws gives no answer; one over its
 * limits is turned off.
 */
async function dispatch(
  event: ModEvent,
  input: Record<string, unknown>,
  ctx: ModContext,
  only?: string,
): Promise<Array<{ plugin: string; answer: unknown }>> {
  const out: Array<{ plugin: string; answer: unknown }> = [];
  const need = EVENT_CAPABILITY[event];
  for (const p of modsFor(ctx)) {
    if (only && p.contents.name !== only) continue;
    if (need && !p.contents.mod!.capabilities.includes(need)) continue;
    const inst = await instanceFor(p, ctx);
    if (!inst) continue;
    try {
      // Set HERE, synchronously before the call: `instanceFor` awaited, and a
      // dispatch for another chat could have set its own context in between —
      // `fs.read` would then read the other chat's folder.
      inst.ctx = ctx;
      const json = withDeadline(inst, MOD_EVENT_DEADLINE_MS, () => {
        const fn = inst.vm.getProp(inst.vm.global, "__dispatch");
        const ev = inst.vm.newString(event);
        const arg = inst.vm.newString(JSON.stringify(input));
        const r = inst.vm.callFunction(fn, inst.vm.undefined, ev, arg);
        fn.dispose();
        ev.dispose();
        arg.dispose();
        if (r.error) throw failure(inst.vm, r.error);
        const s = inst.vm.getString(r.value);
        r.value.dispose();
        return s;
      });
      out.push({ plugin: p.contents.name, answer: JSON.parse(json) });
    } catch (err) {
      if (err instanceof ModLimitError)
        turnOff(
          p.contents.name,
          `it went over its limits on ${event} (${err.message})`,
        );
      else
        logger.warn(
          `mod ${p.contents.name} failed on ${event}: ${(err as Error).message}`,
        );
    }
  }
  return out;
}

export async function modsSessionStart(ctx: ModContext): Promise<void> {
  await dispatch("session.start", {}, ctx);
}

/** The first mod to deny a tool call, or null. */
export async function modsToolCall(
  ctx: ModContext,
  tool: string,
  args: Record<string, unknown>,
): Promise<{ plugin: string; reason: string } | null> {
  const visible = Object.fromEntries(
    Object.entries(args).filter(
      ([k]) => !k.startsWith("_") && k !== "workspace",
    ),
  );
  for (const { plugin, answer } of await dispatch(
    "tool.call",
    { tool, args: visible },
    ctx,
  )) {
    const deny = (answer as { deny?: unknown } | null)?.deny;
    if (typeof deny === "string" && deny)
      return { plugin, reason: deny.slice(0, 2000) };
  }
  return null;
}

/** The prompt after each mod's `prompt.submit` rewrite, in order. */
export async function modsPromptSubmit(
  ctx: ModContext,
  text: string,
): Promise<string> {
  let current = text;
  for (const p of modsFor(ctx)) {
    const [r] = await dispatch(
      "prompt.submit",
      { text: current },
      ctx,
      p.contents.name,
    );
    const next = (r?.answer as { text?: unknown } | null)?.text;
    if (typeof next === "string") current = next.slice(0, PROMPT_MAX);
  }
  return current;
}

/**
 * Sections mods ADD to the turn's context, each labelled with its plugin.
 * Add-only by construction: a mod sees no existing section and returns text,
 * so it can never replace or drop one of Atlarix's.
 */
export async function modsPromptSections(ctx: ModContext): Promise<string[]> {
  const out: string[] = [];
  for (const { plugin, answer } of await dispatch("prompt.compose", {}, ctx)) {
    const sections = (answer as { sections?: unknown } | null)?.sections;
    if (!Array.isArray(sections)) continue;
    for (const s of sections.slice(0, SECTIONS_PER_MOD)) {
      if (typeof s === "string" && s.trim())
        out.push(`From the ${plugin} mod:\n${s.slice(0, SECTION_MAX)}`);
    }
  }
  return out;
}

/** Every mod-registered command (loading mods as needed). */
export async function modCommands(ctx: ModContext): Promise<ModCommand[]> {
  const out: ModCommand[] = [];
  for (const p of modsFor(ctx)) {
    if (!p.contents.mod!.capabilities.includes("command")) continue;
    const inst = await instanceFor(p, ctx);
    if (inst) out.push(...inst.commands);
  }
  return out;
}

/** `/name rest` answered by a mod's `command.run`, or null when no mod has it. */
export async function modsRunCommand(
  ctx: ModContext,
  text: string,
): Promise<string | null> {
  const m = /^\/([a-z0-9][a-z0-9_-]*)(?:\s+([\s\S]*))?$/.exec(text.trim());
  if (!m) return null;
  const owner = (await modCommands(ctx)).find((c) => c.name === m[1]);
  if (!owner) return null;
  const [r] = await dispatch(
    "command.run",
    { name: owner.name, args: (m[2] ?? "").trim() },
    ctx,
    owner.plugin,
  );
  const answer = (r?.answer as { text?: unknown } | null)?.text;
  return typeof answer === "string" ? answer.slice(0, 20_000) : "";
}

/** A UI tree: `{ type: "Box"|"Text"|"Button"|"List", props?, children? }`. */
export interface ModNode {
  type: "Box" | "Text" | "Button" | "List";
  props?: {
    text?: string;
    action?: string;
    direction?: "row" | "column";
    tone?: "muted" | "accent" | "warn";
  };
  children?: ModNode[];
}

/** Draw a pane: the mod's tree for it, validated, or null. */
export async function modsRenderPane(
  ctx: ModContext,
  plugin: string,
  id: string,
): Promise<ModNode | null> {
  const [r] = await dispatch(
    "ui.render",
    { component: "Pane", requestId: id },
    ctx,
    plugin,
  );
  return validTree(r?.answer);
}

export async function modsUiAction(
  ctx: ModContext,
  plugin: string,
  action: string,
): Promise<void> {
  await dispatch("ui.action", { action: action.slice(0, 200) }, ctx, plugin);
}

const NODE_TYPES = new Set(["Box", "Text", "Button", "List"]);

/** Only the four element types and their known props survive; anything else drops the tree. */
export function validTree(raw: unknown): ModNode | null {
  if (raw == null) return null;
  if (JSON.stringify(raw).length > TREE_MAX_BYTES) return null;
  const walk = (n: unknown, depth: number): ModNode | null => {
    if (!n || typeof n !== "object" || depth > 12) return null;
    const node = n as Record<string, unknown>;
    if (typeof node.type !== "string" || !NODE_TYPES.has(node.type))
      return null;
    const p = (node.props ?? {}) as Record<string, unknown>;
    const props: ModNode["props"] = {};
    if (typeof p.text === "string") props.text = p.text;
    if (typeof p.action === "string") props.action = p.action.slice(0, 200);
    if (p.direction === "row" || p.direction === "column")
      props.direction = p.direction;
    if (p.tone === "muted" || p.tone === "accent" || p.tone === "warn")
      props.tone = p.tone;
    const children = Array.isArray(node.children)
      ? node.children
          .map((c) => walk(c, depth + 1))
          .filter((c): c is ModNode => !!c)
      : undefined;
    return {
      type: node.type as ModNode["type"],
      props,
      ...(children ? { children } : {}),
    };
  };
  return walk(raw, 0);
}

/** Open panes per mod, for a surface that starts after they were opened. */
export function openModPanes(): Array<{
  plugin: string;
  id: string;
  title: string;
}> {
  return [...instances.values()].flatMap((i) =>
    [...i.panes].map(([id, title]) => ({ plugin: i.plugin, id, title })),
  );
}

/** Tests only. */
export function _resetModsForTests(): void {
  for (const i of instances.values()) {
    i.vm.dispose();
    i.runtime.dispose();
  }
  instances.clear();
  turnedOff.clear();
  sessionState.clear();
}
