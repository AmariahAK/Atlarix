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
  trigger:
    | { kind: "schedule"; cron: string; preset?: string }
    | { kind: "mcp"; serverId?: number; accountServer?: string; tool: string; intervalMinutes: number; args?: unknown };
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
  /** A browser sign-in it still needs before it works. */
  needsSignIn?: boolean;
  /** How its last connection in this process went; absent until it has been tried. */
  connection?: { ok: true } | { ok: false; error: string };
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
  /** One the user added: an endpoint of their own. */
  custom?: boolean;
  /** One the user added that speaks the Anthropic Messages API (unset: OpenAI-compatible). */
  apiFormat?: "anthropic";
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
import type { AddedServer, PasteOutcome } from "@/lib/mcp/mcp-add";
import type { ConnectorView } from "@/lib/mcp/account-connectors";
import type { CatalogEntry } from "@/shared/mcp-catalog";

export interface CliServices {
  /** Usage on this computer (/usage): activity, tokens, MCP & skills, Auto picks, BYOK estimate. */
  usage(filters: import("@/lib/stats/usage-report").UsageFilters): Promise<import("@/lib/stats/usage-report").UsageReport>;
  /** The account's Atlarix credits (/usage Credits). */
  usageCredits(): Promise<import("@/lib/billing/usage-credits").UsageCredits>;
  /** Writes the share card (SVG) to Downloads; returns its path. */
  saveUsageCard(svg: string): Promise<string>;
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
    /** Connect the servers not yet tried in this process (never tears down a working one). */
    probe(ids: number[]): Promise<void>;
    tools(id: number): Promise<Array<{ name: string; description?: string }>>;
    /** A command (`npx -y @x/mcp`) starts a local server; a URL connects to a remote one. */
    add(appId: number, server: { name: string; command?: string; url?: string }): Promise<void>;
    setEnabled(id: number, enabled: boolean): Promise<void>;
    remove(id: number): Promise<void>;
    /** A server that needs a browser sign-in (OAuth): start it. */
    signIn(id: number): Promise<{ ok: boolean; error?: string }>;
    /** Servers set up in other tools on this computer, not yet in this folder (names, never env values). */
    found(appId: number): Promise<Array<{ key: string; source: string; name: string; transport: string; summary: string; envNames: string[]; scope: string }>>;
    /** Add one of those to this folder. */
    importFound(appId: number, key: string): Promise<void>;
    /**
     * Add your own: a URL, a command line, a config block, or the path of a
     * config file. A public https server goes on the account (every surface);
     * the rest stays in this folder.
     */
    paste(appId: number, text: string): Promise<PasteOutcome>;
    /** Search the marketplace (official MCP Registry, cached), Verified first. */
    catalog(appId: number, query: string, offset?: number): Promise<{ entries: CatalogEntry[]; total: number; installed: string[] }>;
    install(appId: number, name: string, optionId: string, values: Record<string, string>): Promise<AddedServer>;
    /** The user's default servers (every workspace offers them) and where each stands here. */
    defaults(appId: number): Promise<import("@/lib/mcp/default-servers").DefaultMcpServerStatus[]>;
    /** Web servers on the account (null when signed out). */
    account(): Promise<ConnectorView[] | null>;
    accountSetEnabled(appId: number, id: string, enabled: boolean): Promise<void>;
    accountRemove(id: string): Promise<void>;
    /** Sign in in the browser; `onUrl` gets the page as soon as it exists. */
    accountSignIn(appId: number, id: string, onUrl: (url: string) => void): Promise<{ ok: boolean; enabled: boolean; error?: string }>;
    accountSecret(appId: number, id: string, secret: string): Promise<void>;
    /** A local server's API key. */
    setKey(id: number, key: string): Promise<void>;
    /** A suggestion card: connect its server (what still needs the user comes back). */
    suggestConnect(id: string, optionId: string | undefined, values: Record<string, string>): Promise<AddedServer>;
    /** It works now: tell the agent. */
    suggestFinish(id: string): Promise<{ connected: boolean; server?: string; tools?: string[]; reason?: string }>;
    suggestDismiss(id: string): Promise<void>;
    /** Servers on now (this folder's plus the account's) and the most that can be. */
    limit(appId: number | null): Promise<{ on: number; max: number }>;
    /** A server's logo as a checked data: URL: by registry name, by URL, or by an added server's name. */
    icon(appId: number | null, ref: { name?: string; url?: string; serverName?: string }): Promise<string | null>;
    /** Servers an automation can watch: this folder's and the account's, by ref (`local:<id>` / `account:<name>`). */
    watchable(appId: number): Promise<Array<{ ref: string; name: string; detail: string }>>;
    /** A watchable server's tools. */
    watchTools(ref: string): Promise<Array<{ name: string; description?: string }>>;
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
    /** A custom provider's address, changed after checking something answers there. */
    setBaseUrl(providerId: string, baseUrl: string): Promise<void>;
    /** Ask the provider whether the saved key works, or `key` before it is saved. */
    test(providerId: string, key?: string): Promise<KeyCheck>;
    /** Add an endpoint of your own (OpenAI-compatible unless `apiFormat` says Anthropic) with its key; returns its id and how many models it lists. */
    addCustom(p: { name: string; baseUrl: string; key: string; models?: string[]; apiFormat?: "openai" | "anthropic" }): Promise<{ id: string; models: number }>;
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
  /**
   * The session rating and `/feedback` (lib/feedback/session-rating.ts).
   * Optional so test fakes need not answer it; without it nothing is asked.
   */
  feedback?: {
    /** When the rating was last answered or dismissed on any surface. */
    askedAt(): Promise<number | undefined>;
    noteAsked(): Promise<void>;
    /** ATLARIX_FORCE_RATING=1: ask after the first turn. */
    force(): boolean;
    send(
      answer: { kind: "rating"; rating: 1 | 2 | 3 } | { kind: "text"; body: string },
      session: { mode?: string; effort?: string; provider?: string; model?: string; turns?: number; startedAt?: number },
    ): Promise<{ ok: boolean; error?: string }>;
  };
  account: {
    email(): Promise<string | null>;
    /** Your name, picture (a data: URL) and how you signed in, from GitHub or Google; nulls when unknown. */
    profile?(): Promise<{ name: string | null; avatar: string | null; provider: string | null }>;
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
  constructor(hint = "") {
    super(`That endpoint didn't list any models.${hint} Type the id of the model to use.`);
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

/** `[mcp:update-server] Error: 10 MCP servers…` → `10 MCP servers…`: the handler's wrapper is not for people. */
export function plainError(e: unknown): Error {
  const raw = e instanceof Error ? e.message : String(e);
  let msg = raw;
  for (let i = 0; i < 3; i++) msg = msg.replace(/^\s*(\[[\w:.-]+\]\s*)?((?:[A-Z]\w*)?Error:\s*)?/, "");
  return new Error(msg.trim() || raw);
}

async function call<T>(channel: string, ...args: unknown[]): Promise<T> {
  await ensureHandlers();
  try {
    return await invoke<T>(channel, ...args);
  } catch (e) {
    throw plainError(e);
  }
}

export const realServices: CliServices = {
  /** Usage on this computer: read straight from the shared database. */
  usage: async (filters) => (await import("@/lib/stats/usage-report")).getUsageReport(filters),
  usageCredits: async () => (await import("@/lib/billing/usage-credits")).getUsageCredits(),
  async saveUsageCard(svg) {
    const [{ promises: fs }, os, path] = await Promise.all([import("node:fs"), import("node:os"), import("node:path")]);
    const dir = path.join(os.homedir(), "Downloads");
    await fs.mkdir(dir, { recursive: true });
    const stem = path.join(dir, `atlarix-usage-${new Date().toISOString().slice(0, 10)}`);
    // Never over a file that is already there (an earlier card, or anything else).
    for (let n = 1; ; n++) {
      const file = n === 1 ? `${stem}.svg` : `${stem}-${n}.svg`;
      try {
        await fs.writeFile(file, svg, { encoding: "utf8", flag: "wx" });
        return file;
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== "EEXIST" || n >= 100) throw e;
      }
    }
  },
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
      const status = await call<Record<number, McpServerSummary["connection"]>>("mcp:connection-status", {
        serverIds: rows.map((r) => Number(r.id)),
      }).catch(() => ({}) as Record<number, McpServerSummary["connection"]>);
      return rows.map((r) => ({
        id: Number(r.id),
        name: String(r.name ?? `Server ${r.id}`),
        transport: String(r.transport ?? ""),
        enabled: r.enabled !== false,
        needsSignIn: r.authType === "oauth" && r.oauthConnected !== true,
        ...(status[Number(r.id)] ? { connection: status[Number(r.id)] } : {}),
      }));
    },
    test: (id) => call("mcp:test-connection", id),
    async probe(ids) {
      if (ids.length) await call("mcp:connection-status", { serverIds: ids, probe: true });
    },
    found: (appId) => call("mcp:discover-external", { appId }),
    async importFound(appId, key) {
      await call("mcp:import-external", { appId, key });
    },
    async signIn(id) {
      try {
        const r = await call<{ status?: string }>("mcp:start-oauth", { serverId: id });
        return { ok: r?.status === "authorized" || r?.status === "redirect" };
      } catch (e) {
        return { ok: false, error: (e as Error).message };
      }
    },
    async add(appId, server) {
      // Through the same path as a paste, so a public URL goes on the account.
      const out = await call<PasteOutcome>("mcp:add-pasted", {
        appId,
        text: server.url?.trim() || server.command?.trim() || "",
        name: server.name.trim(),
      });
      if (out.failed[0]) throw new Error(out.failed[0].error);
    },
    async paste(appId, text) {
      // A path to a config file (Claude Desktop's, Cursor's…) reads the file.
      const trimmed = text.trim().replace(/^["']|["']$/g, "");
      if (/\.jsonc?$/i.test(trimmed) && !/^\s*[{"]/.test(trimmed)) {
        const { readFile } = await import("node:fs/promises");
        const { homedir } = await import("node:os");
        const file = trimmed.replace(/^~(?=$|[\\/])/, homedir());
        const body = await readFile(file, "utf8").catch(() => null);
        if (body == null) throw new Error(`Couldn't read ${trimmed}.`);
        return call("mcp:add-pasted", { appId, text: body });
      }
      return call("mcp:add-pasted", { appId, text });
    },
    catalog: (appId, query, offset = 0) => call("mcp-catalog:search", { appId, query, offset, limit: 50 }),
    install: (appId, name, optionId, values) => call("mcp-catalog:install", { appId, name, optionId, values }),
    defaults: (appId) => call("mcp:defaults", { appId }),
    account: () => call("connectors:list"),
    async accountSetEnabled(appId, id, enabled) {
      await call("connectors:set-enabled", { appId, id, enabled });
    },
    async accountRemove(id) {
      await call("connectors:remove", { id });
    },
    async accountSignIn(appId, id, onUrl) {
      // In-process rather than through the handler, so the page can be shown
      // here as soon as it exists (a terminal may have no browser).
      const { signInAccountServer } = await import("@/lib/mcp/mcp-add");
      return signInAccountServer(id, appId, { onUrl });
    },
    async accountSecret(appId, id, secret) {
      await call("connectors:set-secret", { appId, id, secret });
    },
    async setKey(id, key) {
      await call("mcp:update-server", { id, apiKey: key });
    },
    suggestConnect: (id, optionId, values) => call("mcp-suggest:connect", { id, ...(optionId ? { optionId } : {}), values }),
    suggestFinish: (id) => call("mcp-suggest:finish", { id }),
    limit: (appId) => call("mcp:limit", { appId }),
    async suggestDismiss(id) {
      await call("mcp-suggest:dismiss", { id });
    },
    async icon(appId, ref) {
      if (ref.serverName) return call<string | null>("mcp:server-icon", { appId, name: ref.serverName });
      if (ref.name) return call<string | null>("mcp-catalog:icon", { name: ref.name });
      if (ref.url) return call<string | null>("mcp-catalog:icon", { url: ref.url });
      return null;
    },
    async watchable(appId) {
      const [local, account] = await Promise.all([
        realServices.mcp.list(appId).catch(() => []),
        realServices.mcp.account().catch(() => null),
      ]);
      return [
        ...local.map((s) => ({ ref: `local:${s.id}`, name: s.name, detail: `this computer · ${s.transport}` })),
        ...(account ?? []).map((c) => ({ ref: `account:${c.name}`, name: c.name, detail: "all devices" })),
      ];
    },
    async watchTools(ref) {
      if (ref.startsWith("account:")) {
        const name = ref.slice("account:".length);
        const c = ((await realServices.mcp.account()) ?? []).find((x) => x.name === name);
        return (c?.tools ?? []).map((t) => ({ name: t }));
      }
      return realServices.mcp.tools(Number(ref.replace(/^local:/, "")));
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
            // "none" is the stand-in for a server that needs no key (addCustom).
            ...(key ? { keyHint: key === "none" ? "none" : keyHint(key) } : {}),
            ...((p as { type?: string }).type === "custom" ? { custom: true } : {}),
            ...(p.apiFormat === "anthropic" ? { apiFormat: "anthropic" as const } : {}),
            ...(settings.providerSettings?.[p.id]?.enabled === false ? { off: true } : {}),
            ...(p.apiBaseUrl ? { baseUrl: p.apiBaseUrl } : {}),
          };
        })
        .sort((a, b) => Number(b.hasKey) - Number(a.hasKey) || a.name.localeCompare(b.name)),
      ];
    },
    async saveKey(providerId, key) {
      const k = key.trim();
      // Asked before it is saved, as adding one is: a key the provider refuses
      // changes nothing (QA: a replaced key was saved although both headers
      // were refused). Unreachable or unlistable still saves; only a refusal stops it.
      const { getLanguageModelProviders } = await import("@/ipc/shared/language_model_helpers");
      const p = (await getLanguageModelProviders()).find((x) => x.id === providerId);
      let authHeader: "x-api-key" | "bearer" | undefined;
      if (p?.apiFormat === "anthropic" && p.apiBaseUrl) {
        // A new key for an Anthropic-format endpoint may want the other header.
        const { detectAnthropicAuth } = await import("@/lib/provider-key-check");
        const found = await detectAnthropicAuth(p.apiBaseUrl, k);
        if (found.check.status === "rejected") throw new Error(`The key was rejected: ${found.check.detail}. Nothing was changed.`);
        authHeader = found.authHeader;
      } else {
        const check = await realServices.providers.test(providerId, k).catch(() => null);
        if (check?.status === "rejected") throw new Error(`The key was rejected: ${check.detail}. Nothing was changed.`);
      }
      const { writeProviderKey } = await import("@/main/settings");
      // Encrypted with the desktop's OS key (entry.mts installs that key), so
      // the desktop app reads the same key. Only this provider's key changes.
      writeProviderKey(providerId, k);
      // The desktop's key handler counts this; the CLI writes the key directly.
      const [{ trackModelConnected }, { modelConnectedFor }] = await Promise.all([
        import("@/main/lib/analytics"),
        import("@/lib/analytics/model-connected"),
      ]);
      await trackModelConnected(modelConnectedFor(providerId));
      if (p && authHeader && authHeader !== (p.authHeader ?? "x-api-key")) {
        const { CUSTOM_PROVIDER_PREFIX } = await import("@/ipc/shared/language_model_helpers");
        const { registerLanguageModelHandlers } = await import("@/ipc/handlers/language_model_handlers");
        await ensureLanguageModelHandlers(registerLanguageModelHandlers);
        await invoke("edit-custom-language-model-provider", {
          id: providerId.slice(CUSTOM_PROVIDER_PREFIX.length),
          name: p.name,
          apiBaseUrl: p.apiBaseUrl,
          authHeader,
        });
      }
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
        // `atlarix keys remove` reaches here with no database open yet.
        const { initializeDatabase } = await import("@/db");
        initializeDatabase();
        const { registerLanguageModelHandlers } = await import("@/ipc/handlers/language_model_handlers");
        await ensureLanguageModelHandlers(registerLanguageModelHandlers);
        await invoke("delete-custom-language-model-provider", { providerId });
      }
    },
    async setBaseUrl(providerId, baseUrl) {
      const { CUSTOM_PROVIDER_PREFIX, getLanguageModelProviders } = await import("@/ipc/shared/language_model_helpers");
      if (!providerId.startsWith(CUSTOM_PROVIDER_PREFIX)) throw new Error("Only a provider you added has an address to change.");
      const base = baseUrl.trim().replace(/\/+$/, "");
      if (!/^https?:\/\/\S+$/i.test(base)) throw new Error("The base URL starts with https:// (or http:// for one on this computer).");
      const p = (await getLanguageModelProviders()).find((x) => x.id === providerId);
      if (!p) throw new Error("That provider isn't there any more.");
      // Something has to answer at the new address before it replaces the old.
      const { keyProbe, checkProviderKey } = await import("@/lib/provider-key-check");
      const { readSettings } = await import("@/main/settings");
      const key = (readSettings() as { providerSettings?: Record<string, { apiKey?: { value?: string } }> }).providerSettings?.[providerId]?.apiKey?.value ?? "none";
      const check = await checkProviderKey(keyProbe(providerId, key, base, { apiFormat: p.apiFormat, authHeader: p.authHeader })!, key);
      if (check.status === "unreachable") throw new Error(`${check.detail.replace(/^Couldn't reach the provider/, `Couldn't reach ${base}`).replace(/[.?!\s]+$/, "")}. Nothing was changed.`);
      if (check.status === "rejected") throw new Error(`The key was rejected there: ${check.detail}. Nothing was changed.`);
      const { registerLanguageModelHandlers } = await import("@/ipc/handlers/language_model_handlers");
      await ensureLanguageModelHandlers(registerLanguageModelHandlers);
      await invoke("edit-custom-language-model-provider", { id: providerId.slice(CUSTOM_PROVIDER_PREFIX.length), name: p.name, apiBaseUrl: base });
      const { invalidateProviderModelCache } = await import("@/lib/provider_model_fetchers");
      invalidateProviderModelCache(providerId);
    },
    async test(providerId, candidate) {
      const { readSettings } = await import("@/main/settings");
      const { getLanguageModelProviders } = await import("@/ipc/shared/language_model_helpers");
      const { keyProbe, checkProviderKey } = await import("@/lib/provider-key-check");
      const settings = readSettings() as { providerSettings?: Record<string, { apiKey?: { value?: string } }> };
      const key = candidate?.trim() || settings.providerSettings?.[providerId]?.apiKey?.value?.trim();
      if (!key) return { status: "unchecked", detail: "No key saved." };
      const provider = (await getLanguageModelProviders()).find((p) => p.id === providerId);
      // An Anthropic-format endpoint: asked as the app asks it (either header,
      // and /messages when it lists no models), and the header that worked is
      // kept, once the key is the saved one (QA B2).
      if (provider?.apiFormat === "anthropic" && provider.apiBaseUrl) {
        const { detectAnthropicAuth } = await import("@/lib/provider-key-check");
        const found = await detectAnthropicAuth(provider.apiBaseUrl, key);
        const saved = settings.providerSettings?.[providerId]?.apiKey?.value?.trim();
        if (key === saved && found.check.status !== "rejected" && found.authHeader !== (provider.authHeader ?? "x-api-key")) {
          const { CUSTOM_PROVIDER_PREFIX } = await import("@/ipc/shared/language_model_helpers");
          const { registerLanguageModelHandlers } = await import("@/ipc/handlers/language_model_handlers");
          await ensureLanguageModelHandlers(registerLanguageModelHandlers);
          await invoke("edit-custom-language-model-provider", {
            id: providerId.slice(CUSTOM_PROVIDER_PREFIX.length),
            name: provider.name,
            apiBaseUrl: provider.apiBaseUrl,
            authHeader: found.authHeader,
          });
        }
        return found.check;
      }
      const wire = provider?.type === "custom" ? { apiFormat: provider.apiFormat, authHeader: provider.authHeader } : undefined;
      return checkProviderKey(keyProbe(providerId, key, provider?.apiBaseUrl, wire), key);
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
    async addCustom({ name, baseUrl, key: given, models, apiFormat = "openai" }) {
      // A server on this computer (LM Studio, llama.cpp, vLLM) often needs no
      // key; the client still sends one, so a stand-in it will ignore.
      const key = given.trim() || "none";
      const { CUSTOM_PROVIDER_PREFIX } = await import("@/ipc/shared/language_model_helpers");
      const { keyProbe, checkProviderKey, detectAnthropicAuth } = await import("@/lib/provider-key-check");
      const base = baseUrl.trim().replace(/\/+$/, "");
      if (!/^https?:\/\//i.test(base)) throw new Error("The base URL starts with https:// (or http:// for one on this computer).");
      const slug = name.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "custom";
      const { getLanguageModelProviders } = await import("@/ipc/shared/language_model_helpers");
      if ((await getLanguageModelProviders()).some((p) => p.id === CUSTOM_PROVIDER_PREFIX + slug)) {
        throw new Error(`You already have a provider called ${name.trim()}. Remove it first, or use another name.`);
      }
      let ids = (models ?? []).map((m) => m.trim()).filter(Boolean);
      // An Anthropic-format endpoint takes the key as `x-api-key` or as a Bearer
      // token: find out which before anything is saved.
      let authHeader: "x-api-key" | "bearer" | undefined;
      let found: Awaited<ReturnType<typeof detectAnthropicAuth>> | undefined;
      if (apiFormat === "anthropic" && key !== "none") {
        found = await detectAnthropicAuth(base, key.trim());
        authHeader = found.authHeader;
        // Refused in both headers: say so, even with the model ids given (QA A3).
        if (found.check.status === "rejected") throw new Error(`The key was rejected: ${found.check.detail}`);
      }
      if (!ids.length) {
        // The endpoint's own list. Asked before anything is saved, so a wrong
        // URL or key leaves nothing behind.
        const probe = keyProbe(CUSTOM_PROVIDER_PREFIX + slug, key.trim(), base, { apiFormat, authHeader })!;
        const check = found?.check ?? (await checkProviderKey(probe, key.trim()));
        if (check.status === "rejected") throw new Error(`The key was rejected: ${check.detail}`);
        // Nothing answered there (a wrong port, the server not running): say so,
        // and save nothing. It used to be "didn't list any models", then saved.
        if (check.status === "unreachable") {
          const why = check.detail.replace(/^Couldn't reach the provider/, `Couldn't reach ${base}`).replace(/[.?!\s]+$/, "");
          throw new Error(`${why}. Check the address, and that the server is running.`);
        }
        if (check.status === "works") {
          if (apiFormat === "anthropic") {
            const { fetchModelsFromAnthropic } = await import("@/lib/provider_model_fetchers");
            ids = (await fetchModelsFromAnthropic(key.trim(), { providerId: CUSTOM_PROVIDER_PREFIX + slug, baseUrl: base, authHeader }))
              .map((m) => m.apiName)
              .slice(0, 200);
          } else {
            ids = await listOpenAICompatibleModels(probe);
          }
        }
        if (!ids.length) {
          // Most of these APIs live under /v1 (http://localhost:11434 → …/v1).
          throw new NoModelsListedError(/\/v\d+$/.test(base) ? "" : ` If its API is under ${base}/v1, use that address instead.`);
        }
      }
      const { registerLanguageModelHandlers } = await import("@/ipc/handlers/language_model_handlers");
      await ensureLanguageModelHandlers(registerLanguageModelHandlers);
      await invoke("create-custom-language-model-provider", {
        id: slug,
        name: name.trim(),
        apiBaseUrl: base,
        ...(apiFormat === "anthropic" ? { apiFormat, ...(authHeader ? { authHeader } : {}) } : {}),
      });
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
  feedback: {
    async askedAt() {
      return (await import("@/main/lib/session-feedback")).ratingAskedAt();
    },
    async noteAsked() {
      (await import("@/main/lib/session-feedback")).noteRatingAsked();
    },
    force: () => process.env.ATLARIX_FORCE_RATING === "1",
    async send(answer, session) {
      return (await import("@/main/lib/session-feedback")).sendSessionFeedback(answer, session);
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
      // Analytics just turned on (the CLI's /analytics, an editor's question):
      // this process's start and today's active day.
      if (v === "opted_in") await import("@/main/lib/analytics").then((m) => m.trackAnalyticsTurnedOn()).catch(() => {});
    },
    track(event, properties) {
      // The start goes through its own path: once per process, and kept until
      // analytics come on if they are off now.
      void import("@/main/lib/analytics")
        .then((m) => (event === "session_started" ? m.trackSessionStarted(properties) : m.captureSafe(event, properties)))
        .catch(() => {});
    },
  },
  account: {
    async email() {
      const { currentEmail } = await import("../auth/account");
      return currentEmail();
    },
    async profile() {
      const { currentProfile } = await import("../auth/account");
      return currentProfile();
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
