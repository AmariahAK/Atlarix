/**
 * `atlarix keys`: your own API keys from a terminal, the place a key can be
 * typed without passing through a chat (Zed and JetBrains point here from
 * /keys). The same store as the app, the CLI's /connect and the editors.
 *
 *   atlarix keys                     each key, checked with its provider
 *   atlarix keys add <provider>      asks for the key (hidden), checks it, saves it
 *   atlarix keys remove <provider>   forgets it
 */
import type { CliServices, ProviderSummary } from "./agent/services";

type Out = (s: string) => void;

/** "openai", "OpenAI" or "open" all find OpenAI; null when nothing or several match. */
export function findProvider(list: readonly ProviderSummary[], query: string): ProviderSummary | ProviderSummary[] | null {
  const q = query.trim().toLowerCase();
  const exact = list.find((p) => p.id.toLowerCase() === q || p.name.toLowerCase() === q);
  if (exact) return exact;
  const hits = list.filter((p) => p.id.toLowerCase().startsWith(q) || p.name.toLowerCase().startsWith(q));
  return hits.length === 1 ? hits[0]! : hits.length ? hits.slice(0, 8) : null;
}

/** Read a line without echoing it (a key never shows on screen or in scrollback). */
export function readHidden(prompt: string, out: Out = (s) => process.stdout.write(s)): Promise<string> {
  return new Promise((resolve, reject) => {
    const stdin = process.stdin;
    out(prompt);
    if (!stdin.isTTY) {
      // Piped in (`echo $KEY | atlarix keys add x`): read it whole.
      let data = "";
      stdin.setEncoding("utf8");
      stdin.on("data", (c) => (data += c));
      stdin.on("end", () => resolve(data.trim()));
      return;
    }
    let value = "";
    stdin.setRawMode(true);
    stdin.resume();
    stdin.setEncoding("utf8");
    const done = (fn: () => void) => {
      stdin.setRawMode(false);
      stdin.pause();
      stdin.removeListener("data", onData);
      out("\n");
      fn();
    };
    const onData = (chunk: string) => {
      for (const ch of chunk) {
        if (ch === "\r" || ch === "\n") return done(() => resolve(value.trim()));
        if (ch === "\u0003") return done(() => reject(new Error("cancelled")));
        if (ch === "\u007f" || ch === "\b") value = value.slice(0, -1);
        else if (ch >= " ") value += ch;
      }
    };
    stdin.on("data", onData);
  });
}

export async function runKeysCommand(
  args: string[],
  services: Pick<CliServices, "providers">,
  io: { out: Out; readKey: (prompt: string) => Promise<string> },
): Promise<number> {
  const { out } = io;
  const providers = await services.providers.list();
  const [verb, query] = args;

  if (!verb || verb === "list") {
    const mine = providers.filter((p) => p.hasKey);
    if (!mine.length) {
      out("No API keys of your own yet. Add one: atlarix keys add <provider>\n");
      return 0;
    }
    const checks = await Promise.all(mine.map((p) => services.providers.test(p.id).catch(() => ({ status: "unreachable" as const, detail: "" }))));
    for (const [i, p] of mine.entries()) {
      const c = checks[i]!;
      const mark = c.status === "works" ? "●" : c.status === "rejected" ? "✕" : "○";
      out(`${mark} ${p.name.padEnd(22)} ${(p.keyHint ?? "").padEnd(12)} ${c.status === "works" ? `works (${c.detail})` : c.status === "rejected" ? `rejected: ${c.detail}` : c.detail || c.status}\n`);
    }
    return 0;
  }

  if ((verb === "add" || verb === "replace" || verb === "remove") && !query) {
    out(`Which provider? atlarix keys ${verb} <provider>, for example: atlarix keys ${verb} openai\n`);
    return 1;
  }
  if (verb !== "add" && verb !== "replace" && verb !== "remove") {
    out("Usage: atlarix keys [add|remove <provider>]\n");
    return 1;
  }
  const found = findProvider(providers, query!);
  if (!found) {
    out(`No provider called "${query}". Run atlarix keys add with its name, for example openai, anthropic or deepseek.\n`);
    return 1;
  }
  if (Array.isArray(found)) {
    out(`"${query}" could be: ${found.map((p) => p.id).join(", ")}\n`);
    return 1;
  }

  if (verb === "remove") {
    if (!found.hasKey) {
      out(`No ${found.name} key saved.\n`);
      return 0;
    }
    await services.providers.removeKey(found.id);
    out(`Removed the ${found.name} key. Chats on its models move to Atlarix Auto.\n`);
    return 0;
  }

  if (found.keyUrl) out(`Get a ${found.name} key at ${found.keyUrl}\n`);
  const key = await io.readKey(`${found.name} API key (hidden): `).catch(() => "");
  if (!key) {
    out("Nothing saved.\n");
    return 1;
  }
  const check = await services.providers.test(found.id, key).catch(() => ({ status: "unreachable" as const, detail: "" }));
  if (check.status === "rejected") {
    out(`${found.name} rejected that key: ${check.detail}\nNothing saved.\n`);
    return 1;
  }
  await services.providers.saveKey(found.id, key);
  out(
    check.status === "works"
      ? `Saved. ${found.name} works (${check.detail}); its models are in the model picker.\n`
      : `Saved. ${check.detail || "It couldn't be checked from here."}\n`,
  );
  return 0;
}
