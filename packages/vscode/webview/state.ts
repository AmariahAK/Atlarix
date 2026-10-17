/**
 * What every screen reads: the session, its options (mode, model, thinking),
 * the agent's commands, your keys and how each was last checked, and the
 * extension's own settings. A small bus tells screens when something changed.
 */
import type { SessionConfigOption } from "@agentclientprotocol/sdk";
import type { HostSettings, KeyStatus, ProviderRow } from "../src/protocol";
import { toGroups, type Command, type Group } from "./logic";
import { rpc } from "./rpc";

export interface KeyCheck {
  status: KeyStatus | "checking";
  detail: string;
  at: number;
}

export const state = {
  sessionId: null as string | null,
  workspace: null as string | null,
  where: "sidebar" as "sidebar" | "tab",
  busy: false,
  signedIn: true,
  title: "New chat",
  mode: "build",
  modes: [] as Array<{ value: string; name: string; description?: string | null }>,
  modelGroups: [] as Group[],
  modelValue: "",
  /** The chosen model's effort levels (config id "thinking"); the default is marked "default". */
  thinking: null as { value: string; options: Array<{ value: string; name: string; description?: string | null }> } | null,
  commands: [] as Command[],
  settings: { attachOpenFile: true, ctrlEnterSends: false, notifyWhenNeeded: true } as HostSettings,
  providers: null as ProviderRow[] | null,
  keyChecks: new Map<string, KeyCheck>(),
  planModel: null as string | null,
  chrome: "",
  recapOn: true,
  usage: { tokens: 0, cachedTokens: 0, cost: 0, used: 0, size: 0 },
};

type Topic = "options" | "keys" | "busy" | "usage" | "settings" | "session";
const subs = new Map<Topic, Set<() => void>>();

export function on(topic: Topic, fn: () => void): () => void {
  if (!subs.has(topic)) subs.set(topic, new Set());
  subs.get(topic)!.add(fn);
  return () => subs.get(topic)?.delete(fn);
}

export function emit(topic: Topic): void {
  for (const fn of subs.get(topic) ?? []) fn();
}

/** Mode, model and thinking from the agent's config options. */
export function applyOptions(opts: SessionConfigOption[]): void {
  state.thinking = null;
  for (const o of opts) {
    if (o.type !== "select") continue;
    const groups = toGroups(o.options as Array<Group | { value: string; name: string }>);
    if (o.id === "mode") {
      state.mode = String(o.currentValue);
      state.modes = groups.flatMap((g) => g.options);
    } else if (o.id === "model") {
      state.modelGroups = groups;
      state.modelValue = String(o.currentValue);
    } else if (o.id === "thinking") {
      state.thinking = { value: String(o.currentValue), options: groups.flatMap((g) => g.options) };
    }
  }
  emit("options");
}

/** The model's name as the picker shows it. */
export function modelName(value = state.modelValue): string {
  for (const g of state.modelGroups) for (const o of g.options) if (o.value === value) return o.name;
  return value.split("/").slice(1).join("/") || value;
}

/** Your providers (fetched once, again after a change), each key checked with its provider once. */
export async function loadProviders(force = false): Promise<ProviderRow[]> {
  if (state.providers && !force) return state.providers;
  const r = await rpc<{ providers: ProviderRow[] }>("_atlarix/providers");
  state.providers = r.providers;
  emit("keys");
  for (const p of r.providers) if (p.hasKey && (!state.keyChecks.has(p.id) || force)) void checkKey(p.id);
  return r.providers;
}

export async function checkKey(providerId: string): Promise<void> {
  state.keyChecks.set(providerId, { status: "checking", detail: "", at: Date.now() });
  emit("keys");
  const r = await rpc<{ status: KeyStatus; detail: string }>("_atlarix/provider_test", { providerId }).catch((e: Error) => ({
    status: "unreachable" as const,
    detail: e.message,
  }));
  state.keyChecks.set(providerId, { ...r, at: Date.now() });
  emit("keys");
}

/** Providers with a saved key whose check said it doesn't work. */
export function rejectedProviders(): Set<string> {
  const out = new Set<string>();
  for (const [id, c] of state.keyChecks) if (c.status === "rejected") out.add(id);
  return out;
}
