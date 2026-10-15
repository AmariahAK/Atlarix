/**
 * `list_available_mcps` and `mcp_call` — the account's connectors.
 *
 * TWO TOOLS, NOT THREE. The desktop has a `manage_mcp_server` as well, and it
 * deliberately does not come across: connectors are configured on the account,
 * this package has no approval-card shape for a URL and a credential, and
 * adding a WRITE tool to the surface that reads attacker-controlled web pages
 * is the opposite of what the design is for. The description says where to go
 * instead, so the model does not have to discover that by failing.
 *
 * NOTHING HERE EVER SEES A TOKEN. The proxy holds every credential, makes every
 * call to a remote server, and returns already-wrapped text. That is directly
 * observable: open the panel's DevTools Network tab during a connector call and
 * there is no request to the connector's host at all.
 *
 * THE PROXY WRAPS, SO THIS MUST NOT RE-WRAP. `wrapUntrustedData` no longer
 * no-ops on already-wrapped input (that guard was a breakout and was removed),
 * so a second wrap would NEST rather than collapse — harmless but noisy. More
 * importantly, this module must never STRIP: `stripUntrustedDataEnvelope` is a
 * display-only inverse, and running it on model-facing text would remove the
 * one boundary between a connector's output and an instruction.
 */

import { CoreError, coreProxyFetch } from "../core/client";
import type { ToolContext, ToolOutcome } from "./dispatch";

interface ListedTool {
  name: string;
  description?: string;
  /** Argument names (plain identifiers, checked by the proxy). */
  args?: Array<{ name: string; required?: boolean }>;
}

interface ListedServer {
  name: string;
  description?: string;
  tools: ListedTool[];
  error?: string;
  needsOAuth?: boolean;
  inactive?: boolean;
}

const WHERE = "atlarix.dev/account";

/** Shared failure text, so both tools say the same thing about the same state. */
function signedOut(): ToolOutcome {
  return {
    content:
      "You are not signed in to Atlarix, so account connectors are " +
      "unavailable. Tell the user to sign in from the panel.",
    label: "No connectors",
  };
}

export async function listAvailableMcps(): Promise<ToolOutcome> {
  let body: { ok?: boolean; error?: string; servers?: ListedServer[] };
  try {
    body = await coreProxyFetch("/mcp/list", {});
  } catch (err) {
    if (err instanceof CoreError && (err.status === 401 || err.code === "not_signed_in")) {
      return signedOut();
    }
    return {
      content:
        "Could not read your connectors just now. Say so and carry on without " +
        "them; do not retry in a loop.",
      label: "No connectors",
    };
  }

  if (body.ok === false) {
    return { content: body.error ?? "Connectors are unavailable.", label: "No connectors" };
  }

  const servers = body.servers ?? [];
  if (servers.length === 0) {
    return {
      content:
        `No connectors are set up on this account. The user can add one at ` +
        `${WHERE}. There is no tool here to add one — do not try.`,
      label: "No connectors",
    };
  }

  const lines: string[] = [];
  for (const s of servers) {
    if (s.inactive) {
      lines.push(`- ${s.name} — switched off. Calling it turns it on.`);
      continue;
    }
    if (s.error) {
      lines.push(
        `- ${s.name} — unavailable: ${s.error}` +
          (s.needsOAuth ? ` Tell the user to reconnect it at ${WHERE}.` : ""),
      );
      continue;
    }
    lines.push(`- ${s.name}`);
    for (const t of s.tools) {
      // The argument names, so the first (approved) call is right: a guessed
      // name costs the user another approval (QA 15.7.1).
      const args = t.args?.length ? `(${t.args.map((a) => `${a.name}${a.required ? "*" : ""}`).join(", ")})` : "";
      lines.push(`    ${t.name}${args}${t.description ? ` — ${t.description}` : ""}`);
    }
  }

  return {
    content:
      `Connectors on this account, and the tools each one offers. Call one ` +
      `with mcp_call, using the connector's name exactly as it appears here, and ` +
      `the argument names shown (* = required).\n` +
      lines.join("\n"),
    label: `Listed ${servers.length} connector${servers.length === 1 ? "" : "s"}`,
  };
}

/**
 * A tool the named connector doesn't list, said without asking the user: the
 * model guessed "ask_deepwiki", the user approved, and the call failed with
 * "Unknown tool" (QA 15.7.1 #16). Null whenever the list can't tell — it can't
 * be read, the connector isn't shown under that name (the proxy also takes its
 * slug), or it shows no tools (off, or failing) — and the call is asked as usual.
 */
async function missingTool(server: string, tool: string): Promise<ToolOutcome | null> {
  let body: { ok?: boolean; servers?: ListedServer[] };
  try {
    body = await coreProxyFetch("/mcp/list", {});
  } catch {
    return null;
  }
  const s = body.servers?.find((x) => x.name.toLowerCase() === server.toLowerCase());
  if (!s || s.inactive || s.error || s.tools.length === 0) return null;
  if (s.tools.some((t) => t.name === tool)) return null;
  return {
    content:
      `${s.name} has no tool ${tool}. Its tools: ${s.tools.map((t) => t.name).join(", ")}. ` +
      `Call list_available_mcps for their arguments, then call the right one.`,
    label: `No ${tool} on ${s.name}`,
  };
}

export async function mcpCall(
  args: Record<string, unknown>,
  ctx: Pick<ToolContext, "approvedRetry"> = {},
): Promise<ToolOutcome> {
  const server = typeof args.server === "string" ? args.server.trim() : "";
  const tool = typeof args.tool === "string" ? args.tool.trim() : "";
  if (!server || !tool) {
    return {
      content:
        "Pass both `server` (a connector name from list_available_mcps) and " +
        "`tool`.",
      label: "Called nothing",
    };
  }

  // ASKED EVERY TIME. A connector acts as the user on another service, and this
  // surface reads pages anyone can write: a page that talks the model into a
  // call must still get past the user. Listing stays free; it contacts nothing.
  if (!ctx.approvedRetry) {
    const missing = await missingTool(server, tool);
    if (missing) return missing;
    return {
      content: `Waiting for the user to approve: ${tool} on ${server}.`,
      needsApproval: {
        kind: "action",
        reason: `Atlarix wants to use your ${server} connector.`,
        category: "connector",
        summary: `Run ${tool} on ${server}?`,
      },
    };
  }

  let body: { ok?: boolean; error?: string; result?: string; server?: string };
  try {
    body = await coreProxyFetch("/mcp/call", {
      server,
      tool,
      arguments: args.arguments ?? {},
    });
  } catch (err) {
    if (err instanceof CoreError && (err.status === 401 || err.code === "not_signed_in")) {
      return signedOut();
    }
    return {
      content:
        `The call to ${server} failed inside Atlarix. Do not retry the same ` +
        `call; tell the user what you were trying to do.`,
      label: `${server} failed`,
    };
  }

  if (body.ok === false || typeof body.result !== "string") {
    return {
      content: body.error ?? `${server} returned nothing usable.`,
      label: `${server} failed`,
    };
  }

  // The proxy's envelope, passed through UNTOUCHED, behind a plain header line.
  // The header is deliberately first so the envelope is never at byte 0 — if
  // anything downstream ever does wrap this, it wraps rather than no-ops.
  return {
    content: `Result from connector "${body.server ?? server}" · tool ${tool}\n${body.result}`,
    label: `Used ${body.server ?? server} · ${tool}`,
  };
}
