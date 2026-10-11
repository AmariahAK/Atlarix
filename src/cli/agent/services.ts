/**
 * Everything the CLI's commands read and change besides the conversation:
 * automations, MCP servers, saved permissions, provider keys, the account.
 * All of it goes through the desktop's own handlers and stores (shared
 * database, shared settings), so a change made here is the app's change too.
 *
 * App takes this as an interface (`CliServices`) so the TUI tests drive every
 * screen with a fake and no database.
 */
import { invoke } from "./ipc";

export interface AutomationSummary {
  id: string;
  workspaceId: number | null;
  name: string;
  enabled: boolean;
  trigger: { kind: "schedule"; cron: string; preset?: string } | { kind: "mcp"; serverId: number; tool: string; intervalMinutes: number; args?: unknown };
  prompt: string;
  runMode: "notify-only" | "read-only";
  notifyAgent: boolean;
  model: { provider: string; name: string } | null;
  lastRunAt: number | null;
}

export interface AutomationRun {
  id: string;
  automationId: string;
  automationName: string;
  status: "running" | "ok" | "nothing-to-report" | "error";
  summary: string | null;
  error: string | null;
  unread: boolean;
  triggerContext: string | null;
  startedAt: number;
  finishedAt: number | null;
}

export interface AutomationDraft {
  name: string;
  enabled: boolean;
  trigger: AutomationSummary["trigger"];
  prompt: string;
  runMode: "notify-only" | "read-only";
  notifyAgent: boolean;
  model: { provider: string; name: string } | null;
}

export interface McpServerSummary {
  id: number;
  name: string;
  transport: string;
  enabled: boolean;
}

export interface SavedPermission {
  kind: "command" | "file";
  /** What it covers: a command category, or a file/folder scope. */
  label: string;
  decision: string;
  revoke: { category: string } | { scopeType: string; scopeValue: string };
}

export interface ProviderSummary {
  id: string;
  name: string;
  hasKey: boolean;
  /** Where to get a key, when known. */
  keyUrl?: string;
  /** The saved key, masked ("sk-…a91f"), to tell keys apart. */
  keyHint?: string;
  /** One the user added: an OpenAI-compatible endpoint of their own. */
  custom?: boolean;
  /** Switched off in an editor's Models & keys: the key stays, its models are hidden. */
  off?: boolean;
  /** Where its API lives (shown on the provider's page). */
  baseUrl?: string;
}

/** A local model server (Ollama, LM Studio): whether it answers, and how many models it has. */
export interface LocalProviderStatus {
  id: string;
  name: string;
  running: boolean;
  models: number;
}

export type { KeyCheck } from "@/lib/provider-key-check";
import type { KeyCheck } from "@/lib/provider-key-check";

export type { RelicSummary } from "@/lib/relics/relic-store";
import type { RelicSummary } from "@/lib/relics/relic-store";

export interface CliServices {
  automations: {
    list(appId: number | null): Promise<AutomationSummary[]>;
    runs(appId: number): Promise<AutomationRun[]>;
    create(appId: number, draft: AutomationDraft): Promise<void>;
    update(id: string, draft: AutomationDraft): Promise<void>;
    toggle(id: string, enabled: boolean): Promise<void>;
    remove(id: string): Promise<void>;
    runNow(id: string): Promise<void>;
    markRead(runIds: string[]): Promise<void>;
  };
  mcp: {
    list(appId: number): Promise<McpServerSummary[]>;
    test(id: number): Promise<{ ok: boolean; error?: string; needsOAuth?: boolean }>;
    tools(id: number): Promise<Array<{ name: string; description?: string }>>;
    /** A command (`npx -y @x/mcp`) starts a local server; a URL connects to a remote one. */
    add(appId: number, server: { name: string; command?: string; url?: string }): Promise<void>;
    setEnabled(id: number, enabled: boolean): Promise<void>;
    remove(id: number): Promise<void>;
    /** A server that needs a browser sign-in (OAuth): start it. */
    signIn(id: number): Promise<{ ok: boolean; error?: string }>;
  };
  permissions: {
    list(appId: number): Promise<SavedPermission[]>;
    revoke(appId: number, p: SavedPermission): Promise<void>;
    /** "Edit files in this folder without asking": a directory rule for the whole folder. */
    setFolderEdits(appId: number, on: boolean): Promise<void>;
  };
  providers: {
    list(): Promise<ProviderSummary[]>;
    saveKey(providerId: string, key: string): Promise<void>;
    /** Forget the saved key (a provider the user added goes too). */
    removeKey(providerId: string): Promise<void>;
    /** Ask the provider whether the saved key works, or `key` before it is saved. */
    test(providerId: string, key?: string): Promise<KeyCheck>;
    /** Add an OpenAI-compatible endpoint with its key; returns its id and how many models it lists. */
    addCustom(p: { name: string; baseUrl: string; key: string; models?: string[] }): Promise<{ id: string; models: number }>;
    /** Switch a provider off (its key kept, its models hidden in the terminal and editors) or back on. */
    setEnabled(providerId: string, on: boolean): Promise<void>;
    /** Ollama and LM Studio on this computer. */
    local(): Promise<LocalProviderStatus[]>;
  };
  relics: {
    /** Hosted relics (when signed in) and this folder's local ones, newest first. */
    list(workspaceDir: string): Promise<RelicSummary[]>;
    /** A local one only inside this folder's `.atlarix/relics/`. */
    remove(relic: RelicSummary, workspaceDir: string): Promise<void>;
    setVisibility(id: string, visibility: "private" | "link"): Promise<void>;
  };
  /**
   * Usage analytics, shared with the app: the same `telemetryConsent` setting
   * (one answer covers both) and the same PostHog project. `track` sends only
   * after an opt-in.
   */
  analytics: {
    consent(): Promise<"opted_in" | "opted_out" | "unset">;
    setConsent(v: "opted_in" | "opted_out"): Promise<void>;
    track(event: string, properties?: Record<string, unknown>): void;
  };
  account: {
    email(): Promise<string | null>;
    /** Spendable balance in cents; null when signed out or unknown. */
    balanceCents(): Promise<number | null>;
    /** The header's plan label. Optional so test fakes need not answer it. */
    kind?(): Promise<"signed-out" | "free" | "pro" | "payg">;
    signOut(): Promise<void>;
    /** A Lemon Squeezy checkout link: Pro, or Core credit (cents, $10 minimum). */
    checkout(kind: "pro" | "credit", amountCents?: number): Promise<string | null>;
  };
}

let registered = false;

/** The desktop handlers these screens use, registered once into the stub's ipcMain. */
async function ensureHandlers(): Promise<void> {
  if (registered) return;
  registered = true;
  const [{ registerAutomationHandlers }, { registerMcpHandlers }, { registerCommandPermissionHandlers }, { registerFilePermissionHandlers }, { registerMcpOAuthHandlers }] =
    await Promise.all([
      import("@/ipc/handlers/automation_handlers"),
      import("@/ipc/handlers/mcp_handlers"),
      import("@/ipc/handlers/command_permission_handlers"),
      import("@/ipc/handlers/file_permission_handlers"),
      import("@/ipc/handlers/mcp_oauth_handlers"),
    ]);
  registerAutomationHandlers();
  registerMcpHandlers();
  registerMcpOAuthHandlers();
  registerCommandPermissionHandlers();
  registerFilePermissionHandlers();
}

let languageModelHandlers = false;
async function ensureLanguageModelHandlers(register: () => void): Promise<void> {
  if (languageModelHandlers) return;
  languageModelHandlers = true;
  register();
}

/** The endpoint listed no models: the caller asks for a model id instead. */
export class NoModelsListedError extends Error {
  constructor() {
    super("That endpoint didn't list any models. Type the id of the model to use.");
    this.name = "NoModelsListedError";
  }
}

/** Model ids from an OpenAI-compatible `/models` (the probe that just worked). */
async function listOpenAICompatibleModels(probe: { url: string; headers: Record<string, string> }): Promise<string[]> {
  try {
    const res = await fetch(probe.url, { headers: probe.headers, signal: AbortSignal.timeout(15_000) });
    const j = (await res.json()) as { data?: Array<{ id?: string }> };
    return (j.data ?? []).map((m) => String(m.id ?? "")).filter(Boolean).slice(0, 200);
  } catch {
    return [];
  }
}

async function call<T>(channel: string, ...args: unknown[]): Promise<T> {
  await ensureHandlers();
  return invoke<T>(channel, ...args);
}

export const realServices: CliServices = {
  automations: {
    async list(appId) {
      if (appId != null) {
        const res = await call<{ automations: AutomationSummary[] }>("automations:list", appId);
        return res.automations;
      }
      const { db } = await import("@/db");
      const { automations } = await import("@/db/schema");
      const { desc } = await import("drizzle-orm");
      const { mapAutomation } = await import("@/lib/automations/service");
      const rows = await db.select().from(automations).orderBy(desc(automations.createdAt));
      return rows.map(mapAutomation) as AutomationSummary[];
    },
    runs: (appId) => call("automations:runs", { workspaceId: appId }),
    async create(appId, draft) {
      await call("automations:create", { workspaceId: appId, input: draft });
    },
    async update(id, draft) {
      await call("automations:update", { id, input: draft });
    },
    async toggle(id, enabled) {
      await call("automations:toggle", { id, enabled });
    },
    async remove(id) {
      await call("automations:delete", id);
    },
    async runNow(id) {
      await call("automations:run-now", id);
    },
    async markRead(runIds) {
      if (runIds.length) await call("automations:mark-read", runIds);
    },
  },
  mcp: {
    async list(appId) {
      const rows = await call<Array<Record<string, unknown>>>("mcp:list-servers", { appId });
      return rows.map((r) => ({
        id: Number(r.id),
        name: String(r.name ?? `Server ${r.id}`),
        transport: String(r.transport ?? ""),
        enabled: r.enabled !== false,
      }));
    },
    test: (id) => call("mcp:test-connection", id),
    async signIn(id) {
      try {
        const r = await call<{ status?: string }>("mcp:start-oauth", { serverId: id });
        return { ok: r?.status === "authorized" || r?.status === "redirect" };
      } catch (e) {
        return { ok: false, error: (e as Error).message };
      }
    },
    async add(appId, server) {
      // The app's form, in one line: a command is split into the program and
      // its arguments (stdio); a URL is a remote server (http).
      const parts = server.command?.trim().match(/(?:[^\s"']+|"[^"]*"|'[^']*')+/g)?.map((a) => a.replace(/^["']|["']$/g, "")) ?? [];
      await call("mcp:create-server", {
        appId,
        name: server.name.trim(),
        transport: server.url ? "http" : "stdio",
        command: server.url ? null : (parts[0] ?? null),
        args: server.url ? null : parts.slice(1),
        url: server.url?.trim() || null,
        enabled: true,
      });
    },
    setEnabled: (id, enabled) => call("mcp:update-server", { id, enabled }),
    remove: (id) => call("mcp:delete-server", id),
    async tools(id) {
      const res = await call<unknown>("mcp:list-tools", id);
      const list = Array.isArray(res) ? res : ((res as { tools?: unknown[] })?.tools ?? []);
      return (list as Array<{ name?: string; description?: string }>).map((t) => ({
        name: String(t.name ?? ""),
        description: t.description,
      }));
    },
  },
  permissions: {
    async list(appId) {
      const [commands, files] = await Promise.all([
        call<Array<{ category: string; decision: string }>>("command-permissions:list", { appId }),
        call<Array<{ scopeType: string; scopeValue: string; decision?: string }>>("file-permissions:list", { appId }),
      ]);
      return [
        ...commands.map((c) => ({
          kind: "command" as const,
          label: c.category,
          decision: c.decision,
          revoke: { category: c.category },
        })),
        ...files.map((f) => ({
          kind: "file" as const,
          label: `${f.scopeType === "directory" ? "folder" : f.scopeType} ${f.scopeValue}`,
          decision: f.decision ?? "allow",
          revoke: { scopeType: f.scopeType, scopeValue: f.scopeValue },
        })),
      ];
    },
    async revoke(appId, p) {
      if (p.kind === "command") await call("command-permissions:revoke", { appId, ...p.revoke });
      else await call("file-permissions:revoke", { appId, ...p.revoke });
    },
    async setFolderEdits(appId, on) {
      const { WHOLE_FOLDER } = await import("@/lib/file-permission-scope");
      const rule = { appId, scopeType: "directory", scopeValue: WHOLE_FOLDER };
      const r = on
        ? await call<{ success: boolean; error?: string }>("file-permissions:upsert", { ...rule, decision: "always_allow" })
        : await call<{ success: boolean; error?: string }>("file-permissions:revoke", rule);
      if (r && r.success === false) throw new Error(r.error ?? "Couldn't save that.");
    },
  },
  providers: {
    async list() {
      const { getLanguageModelProviders } = await import("@/ipc/shared/language_model_helpers");
      const { readSettings } = await import("@/main/settings");
      const { keyHint } = await import("@/lib/provider-key-check");
      const settings = readSettings() as { providerSettings?: Record<string, { apiKey?: { value?: string }; enabled?: boolean }> };
      const providers = await getLanguageModelProviders();
      return [
        ...providers
        .filter((p) => p.id !== "compass" && (p as { type?: string }).type !== "local")
        .map((p) => {
          const key = settings.providerSettings?.[p.id]?.apiKey?.value;
          return {
            id: p.id,
            name: p.name,
            hasKey: Boolean(key),
            keyUrl: (p as { websiteUrl?: string }).websiteUrl,
            ...(key ? { keyHint: keyHint(key) } : {}),
            ...((p as { type?: string }).type === "custom" ? { custom: true } : {}),
            ...(settings.providerSettings?.[p.id]?.enabled === false ? { off: true } : {}),
            ...(p.apiBaseUrl ? { baseUrl: p.apiBaseUrl } : {}),
          };
        })
        .sort((a, b) => Number(b.hasKey) - Number(a.hasKey) || a.name.localeCompare(b.name)),
      ];
    },
    async saveKey(providerId, key) {
      const { writeProviderKey } = await import("@/main/settings");
      // Encrypted with the desktop's OS key (entry.mts installs that key), so
      // the desktop app reads the same key. Only this provider's key changes.
      writeProviderKey(providerId, key.trim());
      const { invalidateProviderModelCache } = await import("@/lib/provider_model_fetchers");
      invalidateProviderModelCache(providerId);
    },
    async removeKey(providerId) {
      const { writeProviderKey } = await import("@/main/settings");
      writeProviderKey(providerId, null);
      const { invalidateProviderModelCache } = await import("@/lib/provider_model_fetchers");
      invalidateProviderModelCache(providerId);
      const { CUSTOM_PROVIDER_PREFIX } = await import("@/ipc/shared/language_model_helpers");
      if (providerId.startsWith(CUSTOM_PROVIDER_PREFIX)) {
        const { registerLanguageModelHandlers } = await import("@/ipc/handlers/language_model_handlers");
        await ensureLanguageModelHandlers(registerLanguageModelHandlers);
        await invoke("delete-custom-language-model-provider", { providerId });
      }
    },
    async test(providerId, candidate) {
      const { readSettings } = await import("@/main/settings");
      const { getLanguageModelProviders } = await import("@/ipc/shared/language_model_helpers");
      const { keyProbe, checkProviderKey } = await import("@/lib/provider-key-check");
      const settings = readSettings() as { providerSettings?: Record<string, { apiKey?: { value?: string } }> };
      const key = candidate?.trim() || settings.providerSettings?.[providerId]?.apiKey?.value?.trim();
      if (!key) return { status: "unchecked", detail: "No key saved." };
      const provider = (await getLanguageModelProviders()).find((p) => p.id === providerId);
      return checkProviderKey(keyProbe(providerId, key, provider?.apiBaseUrl), key);
    },
    async setEnabled(providerId, on) {
      const { writeProviderSetting } = await import("@/main/settings");
      writeProviderSetting(providerId, { enabled: on ? null : false });
    },
    async local() {
      // A server that isn't running can hang a connect; the screen shouldn't wait on it.
      const within = <T,>(p: Promise<T>, fallback: T) =>
        Promise.race([p.catch(() => fallback), new Promise<T>((r) => setTimeout(() => r(fallback), 1500))]);
      const [{ fetchOllamaModels }, { fetchLMStudioModels }] = await Promise.all([
        import("@/ipc/handlers/local_model_ollama_handler"),
        import("@/ipc/handlers/local_model_lmstudio_handler"),
      ]);
      const none = { models: [] as unknown[], error: "not running" };
      const [ollama, lmstudio] = await Promise.all([
        within(fetchOllamaModels() as Promise<{ models: unknown[]; error?: string }>, none),
        within(fetchLMStudioModels() as Promise<{ models: unknown[]; error?: string }>, none),
      ]);
      return [
        { id: "ollama", name: "Ollama", running: !ollama.error, models: ollama.models.length },
        { id: "lmstudio", name: "LM Studio", running: !lmstudio.error, models: lmstudio.models.length },
      ];
    },
    async addCustom({ name, baseUrl, key, models }) {
      const { CUSTOM_PROVIDER_PREFIX } = await import("@/ipc/shared/language_model_helpers");
      const { keyProbe, checkProviderKey } = await import("@/lib/provider-key-check");
      const base = baseUrl.trim().replace(/\/+$/, "");
      if (!/^https?:\/\//i.test(base)) throw new Error("The base URL starts with https:// (or http:// for one on this computer).");
      const slug = name.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "custom";
      const { getLanguageModelProviders } = await import("@/ipc/shared/language_model_helpers");
      if ((await getLanguageModelProviders()).some((p) => p.id === CUSTOM_PROVIDER_PREFIX + slug)) {
        throw new Error(`You already have a provider called ${name.trim()}. Remove it first, or use another name.`);
      }
      let ids = (models ?? []).map((m) => m.trim()).filter(Boolean);
      if (!ids.length) {
        // The endpoint's own list. Asked before anything is saved, so a wrong
        // URL or key leaves nothing behind.
        const probe = keyProbe(slug, key.trim(), base)!;
        const check = await checkProviderKey(probe, key.trim());
        if (check.status === "rejected") throw new Error(`The key was rejected: ${check.detail}`);
        if (check.status === "works") ids = await listOpenAICompatibleModels(probe);
        if (!ids.length) throw new NoModelsListedError();
      }
      const { registerLanguageModelHandlers } = await import("@/ipc/handlers/language_model_handlers");
      await ensureLanguageModelHandlers(registerLanguageModelHandlers);
      await invoke("create-custom-language-model-provider", { id: slug, name: name.trim(), apiBaseUrl: base });
      const id = CUSTOM_PROVIDER_PREFIX + slug;
      for (const apiName of ids) {
        await invoke("create-custom-language-model", { apiName, displayName: apiName, providerId: id });
      }
      const { writeProviderKey } = await import("@/main/settings");
      writeProviderKey(id, key.trim());
      return { id, models: ids.length };
    },
  },
  relics: {
    async list(workspaceDir) {
      const { listRelics } = await import("@/lib/relics/relic-store");
      return listRelics(workspaceDir);
    },
    async remove(relic, workspaceDir) {
      const { removeRelic } = await import("@/lib/relics/relic-store");
      await removeRelic(relic, [workspaceDir]);
    },
    async setVisibility(id, visibility) {
      const { setRelicVisibility } = await import("@/lib/relics/relic-store");
      await setRelicVisibility(id, visibility);
    },
  },
  analytics: {
    async consent() {
      const { readSettings } = await import("@/main/settings");
      const v = readSettings().telemetryConsent;
      return v === "opted_in" || v === "opted_out" ? v : "unset";
    },
    async setConsent(v) {
      const { writeSettings } = await import("@/main/settings");
      writeSettings({ telemetryConsent: v });
    },
    track(event, properties) {
      void import("@/main/lib/analytics").then((m) => m.captureSafe(event, properties)).catch(() => {});
    },
  },
  account: {
    async email() {
      const { currentEmail } = await import("../auth/account");
      return currentEmail();
    },
    async checkout(kind, amountCents) {
      const { checkoutUrl } = await import("@/lib/lemonsqueezy");
      return checkoutUrl(kind === "pro" ? "subscription" : "credit", amountCents);
    },
    async balanceCents() {
      // Shared with the relic tool's check: one request for a burst of askers.
      const { creditBalanceCents } = await import("@/lib/billing/credit-balance");
      return creditBalanceCents(5_000);
    },
    async kind() {
      if (!(await this.email())) return "signed-out";
      const { SubscriptionManager } = await import("@/lib/SubscriptionManager");
      if (SubscriptionManager.isPro()) return "pro";
      return ((await this.balanceCents()) ?? 0) > 0 ? "payg" : "free";
    },
    async signOut() {
      const { signOutCli } = await import("../auth/account");
      await signOutCli();
    },
  },
};
