/**
 * /status, /billing and /mcp for editors that have no Atlarix panel (Zed and
 * JetBrains speak plain ACP): the CLI's own answers, as markdown. Atlarix's VS
 * Code extension has an Account panel instead (_atlarix/account in server.ts).
 */
import type { AgentSession } from "../agent/session";

const money = (cents: number | null) => (cents == null ? "unknown" : `$${(cents / 100).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`);
const PLAN: Record<string, string> = { "signed-out": "not signed in", free: "Free", pro: "Pro", payg: "Pay as you go" };
const MANAGE = "https://www.atlarix.dev/account";

export async function accountCommandText(cmd: "status" | "billing" | "mcp" | string, session: AgentSession): Promise<string> {
  const { realServices } = await import("../agent/services");
  const a = realServices.account;
  const email = await a.email().catch(() => null);
  if (cmd === "mcp") {
    const servers = await realServices.mcp.list(session.appId).catch(() => []);
    if (!servers.length) return "No MCP servers in this folder. Add them in the Atlarix app, the CLI (`/mcp`), or Atlarix's VS Code extension.";
    return ["**MCP servers in this folder**", "", ...servers.map((s) => `- ${s.enabled ? "●" : "○"} ${s.name} (${s.transport})${s.enabled ? "" : " — off"}`), "", "Turn them on or off in the Atlarix app or the CLI's `/mcp`."].join("\n");
  }
  if (!email) return "You're not signed in to Atlarix. Run `atlarix login` in a terminal, then try again.";
  const [kind, balance] = await Promise.all([a.kind?.().catch(() => null) ?? null, a.balanceCents().catch(() => null)]);
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
