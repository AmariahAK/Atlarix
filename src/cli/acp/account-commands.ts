/**
 * /status, /billing, /mcp, /automations and /logout for editors that have no Atlarix panel (Zed and
 * JetBrains speak plain ACP): the CLI's own answers, as markdown. Atlarix's VS
 * Code extension has an Account panel instead (_atlarix/account in server.ts).
 */
import type { AgentSession } from "../agent/session";

const money = (cents: number | null) => (cents == null ? "unknown" : `$${(cents / 100).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`);
const PLAN: Record<string, string> = { "signed-out": "not signed in", free: "Free", pro: "Pro", payg: "Pay as you go" };
const MANAGE = "https://www.atlarix.dev/account";

export async function accountCommandText(
  cmd: "status" | "billing" | "mcp" | "logout" | string,
  session: AgentSession,
  editorServers: ReadonlyArray<{ name: string; transport: "stdio" | "http" }> = [],
): Promise<string> {
  const { realServices } = await import("../agent/services");
  const a = realServices.account;
  const email = await a.email().catch(() => null);
  if (cmd === "logout") {
    if (!email) return "You're already signed out. To sign in again, choose Atlarix's sign-in when the editor asks, or run `atlarix login` in a terminal.";
    await a.signOut();
    return `Signed out of ${email}. The CLI on this computer shares this sign-in, so it's signed out too; the Atlarix app keeps its own. To sign in again, start a new chat (the editor will ask), or run \`atlarix login\`.`;
  }
  if (cmd === "augments" || cmd === "plugins") {
    // An editor has no dialog for installing: the list is read-only here, and
    // installing (with its two confirms) happens in the CLI or the app.
    const plugins = await realServices.plugins.list().catch(() => []);
    const lines: string[] = plugins.length
      ? [
          "**Augments**",
          "",
          ...plugins.map((p) => {
            const state = p.problem ? `! ${p.problem}` : p.enabled ? (p.folders ? "on in some folders" : "on") : "off";
            const what = [...p.skills.map((x) => `skill ${x}`), ...p.agents.map((x) => `agent ${x}`), ...p.commands].join(", ");
            return `- ${p.problem ? "!" : p.enabled ? "●" : "○"} ${p.name} — ${state}${what ? ` · ${what}` : ""}`;
          }),
          "",
        ]
      : ["No augments installed.", ""];
    lines.push("Add, update or remove augments with `/augments` in the Atlarix CLI, or in the app's Integrations → Augments.");
    return lines.join("\n");
  }
  if (cmd === "mcp") {
    const [account, servers, found, defaults] = await Promise.all([
      realServices.mcp.account().catch(() => null),
      realServices.mcp.list(session.appId).catch(() => []),
      realServices.mcp.found(session.appId).catch(() => []),
      realServices.mcp.defaults(session.appId).catch(() => []),
    ]);
    const lines: string[] = [];
    if (account?.length) {
      lines.push(
        "**On your account** (every device and the Chrome extension)",
        "",
        ...account.map((c) => `- ${c.enabled ? "●" : "○"} ${c.name}${c.enabled ? "" : c.connected ? " — off" : " — not signed in"}`),
        "",
      );
    }
    if (editorServers.length) {
      lines.push(
        "**From this editor** (for this chat)",
        "",
        ...editorServers.map((s) => `- ● ${s.name} (${s.transport})`),
        "",
      );
    }
    lines.push(
      ...(servers.length
        ? ["**On this computer**", "", ...servers.map((s) => `- ${s.enabled ? "●" : "○"} ${s.name} (${s.transport})${s.enabled ? "" : " — off"}`)]
        : ["No MCP servers on this computer for this folder yet."]),
    );
    const notAdded = defaults.filter((d) => d.state === "not-added");
    if (notAdded.length) {
      lines.push("", "**Your defaults**", "", ...notAdded.map((d) => `- ${d.title}: \`/mcp add ${d.title.toLowerCase()}\``));
    }
    if (found.length) {
      lines.push("", "**Found on this computer**", "", ...found.map((f) => `- ${f.name} · ${f.source}: \`/mcp add ${f.name}\``));
    }
    lines.push("", "`/mcp add` also takes a URL, a command, or a marketplace server's name.");
    return lines.join("\n");
  }
  if (cmd === "automations" || cmd.startsWith("automations ")) return automationsText(cmd.slice("automations".length).trim(), session);
  if (cmd.startsWith("mcp add ")) {
    const arg = cmd.slice("mcp add ".length).trim();
    const name = arg.toLowerCase();
    const found = await realServices.mcp.found(session.appId).catch(() => []);
    const hit = found.find((f) => f.name.toLowerCase() === name);
    if (hit) {
      await realServices.mcp.importFound(session.appId, hit.key);
      return `Added ${hit.name} (from ${hit.source}). It's ready from your next message.`;
    }
    // A URL, a command or a config: the same as pasting it.
    if (/^https?:\/\//i.test(arg) || /^[{"]/.test(arg) || /\s/.test(arg)) {
      const out = await realServices.mcp.paste(session.appId, arg);
      startSignIns(out.added, session.appId, realServices);
      return mcpAddedText(out.added, out.failed[0]?.error);
    }
    // A marketplace server, by title or registry name.
    const page = await realServices.mcp.catalog(session.appId, arg).catch(() => null);
    const entry =
      page?.entries.find((e) => e.title.toLowerCase() === name || e.name.toLowerCase() === name) ?? null;
    if (!entry) return `No server called "${arg}" here or in the marketplace. \`/mcp\` lists what there is.`;
    const option = entry.options.find((o) => (o.kind === "web" || o.supported) && o.inputs.every((i) => !i.required));
    if (!option) {
      return `${entry.title} needs details to set up: add it from the Atlarix app, the CLI's \`/mcp\`, or Atlarix's VS Code extension.`;
    }
    const added = await realServices.mcp.install(session.appId, entry.name, option.id, {});
    startSignIns([added], session.appId, realServices);
    return mcpAddedText([added]);
  }
  if (!email) return "You're not signed in to Atlarix. Run `atlarix login` in a terminal, then try again.";
  const [kind, balance] = await Promise.all([a.kind?.().catch(() => null) ?? null, a.balanceCents().catch(() => null)]);
  if (cmd === "stats") {
    const { statsMarkdown } = await import("@/lib/stats/activity-format");
    return statsMarkdown(await realServices.stats());
  }
  if (cmd === "billing") {
    const lines = ["**Atlarix billing**", "", `Plan: ${PLAN[kind ?? ""] ?? "unknown"} · Credit: ${money(balance)}`, ""];
    if (kind !== "pro") {
      const pro = await a.checkout("pro").catch(() => null);
      if (pro) lines.push(`- [Get Atlarix Pro](${pro})`);
    }
    const credit = await a.checkout("credit", 1000).catch(() => null);
    if (credit) lines.push(`- [Add $10 of credit](${credit}) (any amount from $10 on the [account page](${MANAGE}))`);
    lines.push(`- [Manage or cancel your subscription](${MANAGE})`, `- [Pricing](https://www.atlarix.dev/pricing)`);
    return lines.join("\n");
  }
  const s = session.state;
  return [
    "**Atlarix status**",
    "",
    `- Account: ${email}`,
    `- Plan: ${PLAN[kind ?? ""] ?? "unknown"}`,
    `- Credit: ${money(balance)}`,
    `- This chat: ${s.sessionTokens ? `${s.sessionTokens.toLocaleString()} tokens` : "nothing yet"}${s.costUsd > 0 ? ` · $${s.costUsd.toFixed(4)} on your own keys` : ""}`,
    ...(s.contextPercent != null ? [`- Context: ${s.contextPercent}% full`] : []),
    "",
    "`/billing` for Pro, credit or your subscription · `/mcp` for MCP servers.",
  ].join("\n");
}

const STATUS: Record<string, string> = { works: "works", rejected: "rejected", unchecked: "saved (can't be checked from here)", unreachable: "couldn't reach the provider" };

/**
 * /keys: your own API keys, each checked with its provider. Adding or replacing
 * one happens in a terminal (`atlarix keys add <provider>`, a masked prompt),
 * so a key never passes through the chat, where the editor keeps a copy.
 */
export async function keysCommandText(text: string): Promise<string> {
  // Removing involves no secret, so it happens right here (owner: users want
  // to delete a key, not only replace it).
  const remove = /^\/keys\s+(?:remove|delete)\s+(\S+)/i.exec(text.trim());
  if (remove) {
    const { realServices } = await import("../agent/services");
    const want = remove[1]!.toLowerCase();
    const p = (await realServices.providers.list()).find((x) => x.id.toLowerCase() === want || x.name.toLowerCase() === want);
    if (!p) return `No provider called "${remove[1]}". \`/keys\` lists yours.`;
    if (!p.hasKey) return `No ${p.name} key saved.`;
    await realServices.providers.removeKey(p.id);
    return `Removed the ${p.name} key from this computer (the Atlarix app, the CLI and your editors share it). Chats on its models move to Atlarix Auto.`;
  }
  const add = /^\/keys\s+(add|replace)\s+(\S+)/i.exec(text.trim());
  if (add) {
    const verb = "add";
    return `Run this in a terminal (it asks for the key without showing it, so it never passes through the chat):\n\n\`atlarix keys ${verb} ${add[2]}\`\n\nThen \`/keys\` here to check it.`;
  }
  const { realServices } = await import("../agent/services");
  const mine = (await realServices.providers.list()).filter((p) => p.hasKey);
  if (!mine.length) return "No API keys of your own yet. Add one in a terminal with `atlarix keys add <provider>` (for example `atlarix keys add openai`), or in Atlarix's VS Code extension under Models & keys.";
  const checks = await Promise.all(mine.map((p) => realServices.providers.test(p.id).catch(() => ({ status: "unreachable", detail: "" }))));
  return [
    "**Your keys**",
    "",
    ...mine.map((p, i) => {
      const c = checks[i]!;
      const mark = c.status === "works" ? "●" : c.status === "rejected" ? "✕" : "○";
      const why = c.status === "rejected" && c.detail ? `: ${c.detail}` : "";
      const hint = p.keyHint === "none" ? " (no key needed)" : p.keyHint ? ` \`${p.keyHint}\`` : "";
      return `- ${mark} ${p.name}${hint}: ${STATUS[c.status] ?? c.status}${why}`;
    }),
    "",
    "Add or replace one in a terminal: `atlarix keys add <provider>`. Remove one here: `/keys remove <provider>`.",
  ].join("\n");
}

/**
 * /automations: this folder's automations and their last runs; `run`, `on` and
 * `off` with a name act on one. Making one is a sentence to the agent ("run the
 * tests every weekday at 9"): its automations tool asks you before it saves.
 */
async function automationsText(rest: string, session: AgentSession): Promise<string> {
  const { realServices } = await import("../agent/services");
  const a = realServices.automations;
  const list = await a.list(session.appId);
  const m = /^(run|on|off)\s+(.+)$/i.exec(rest);
  if (m) {
    const want = m[2]!.trim().toLowerCase();
    const hit = list.find((x) => x.name.toLowerCase() === want) ?? list.find((x) => x.name.toLowerCase().includes(want));
    if (!hit) return `No automation called "${m[2]!.trim()}" in this folder. \`/automations\` lists them.`;
    const verb = m[1]!.toLowerCase();
    if (verb === "run") {
      await a.runNow(hit.id);
      return `Running “${hit.name}” now. Its result arrives here when it finishes${hit.notifyAgent ? ", and Atlarix reads it on your next message" : ""}.`;
    }
    await a.toggle(hit.id, verb === "on");
    return `“${hit.name}” is ${verb}.`;
  }
  if (!list.length) {
    return "No automations in this folder yet. Ask Atlarix for one, e.g. “run the tests every weekday at 9 and tell me what fails”: it asks you before saving it.";
  }
  const runs = await a.runs(session.appId).catch(() => []);
  const { describeTrigger } = await import("../tui/screens");
  const lines = ["**Automations in this folder**", ""];
  for (const x of list) {
    const last = runs.find((r) => r.automationId === x.id);
    const result = last ? ` · last: ${last.status === "error" ? "✗" : last.status === "ok" ? "✓" : "–"} ${(last.error ?? last.summary ?? last.status).split("\n")[0]}` : " · not run yet";
    lines.push(`- ${x.enabled ? "●" : "○"} **${x.name}**: ${describeTrigger(x.trigger)}${x.enabled ? "" : " (off)"}${result}`);
  }
  lines.push("", "`/automations run <name>` runs one now · `/automations on|off <name>` · ask Atlarix to make or change one. They run while Atlarix (the app, the CLI or an editor) is open.");
  return lines.join("\n");
}

function mcpAddedText(
  added: Array<{ name: string; where: "account" | "local"; enabled: boolean; needsSignIn: boolean; needsSecret?: unknown; note?: string }>,
  error?: string,
): string {
  if (!added.length) return error ?? "Nothing was added.";
  return added
    .map((a) => {
      const where = a.where === "account" ? "on your account (every device and the Chrome extension)" : "on this computer";
      if (a.needsSignIn) return `Added ${a.name} ${where}. Finish signing in, in the browser page that just opened.`;
      if (a.needsSecret) return `Added ${a.name} ${where}. It needs its key: add it in the Atlarix app or the CLI's \`/mcp\`.`;
      return `Added ${a.name} ${where}.${a.note ? ` ${a.note}` : a.enabled ? " It's ready from your next message." : ""}`;
    })
    .join("\n");
}

/** Start the browser sign-in for each added server that needs one; the editor opens the page. */
function startSignIns(
  added: Array<{ id: string | number; where: "account" | "local"; needsSignIn: boolean }>,
  appId: number,
  services: Awaited<typeof import("../agent/services")>["realServices"],
): void {
  for (const a of added) {
    if (!a.needsSignIn) continue;
    if (a.where === "account") void services.mcp.accountSignIn(appId, String(a.id), () => {}).catch(() => {});
    else void services.mcp.signIn(Number(a.id)).catch(() => {});
  }
}
