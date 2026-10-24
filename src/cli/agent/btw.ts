/**
 * /btw — a side question about the conversation, answered without stopping or
 * joining it (Claude Code's /btw). One call to the session's model with what
 * has been said so far, no tools, and nothing saved: the answer is shown and
 * dropped, so the agent's context and the session's history never see it.
 */
import type { Cell } from "./transcript";

/** Most of the recent conversation; the oldest is dropped first. */
const MAX_CONTEXT_CHARS = 60_000;
const BTW_TIMEOUT_MS = 90_000;

const BTW_SYSTEM = [
  "You are Atlarix, answering a quick side question the user asked while you work on their task.",
  "The conversation so far is given as context. You have no tools in this reply: answer from what is in it and what you know.",
  "If the answer needs something you can't see, say what you'd need to check.",
  "Be brief and direct.",
].join(" ");

/** The conversation as plain text: who said what, tools as one line each. */
export function conversationText(cells: Cell[], max = MAX_CONTEXT_CHARS): string {
  const lines: string[] = [];
  for (const c of cells) {
    if (c.kind === "user") lines.push(`User: ${c.text}`);
    else if (c.kind === "answers") for (const p of c.pairs) lines.push(`Atlarix asked: ${p.question}\nUser answered: ${p.answer}`);
    else if (c.kind === "markdown") lines.push(`Atlarix: ${c.text}`);
    else if (c.kind === "tool") {
      // How it ended matters: a recap once called a stopped turn "now reading files" (QA E5).
      const how = c.tool.status === "interrupted" ? " (stopped)" : c.tool.status === "error" ? " (failed)" : c.tool.status === "running" ? " (still running)" : "";
      lines.push(`[${c.tool.verb} ${c.tool.target}${c.tool.summary ? ` → ${c.tool.summary}` : ""}${how}]`);
    } else if (c.kind === "footer" && c.interrupted) lines.push("[The user stopped this turn.]");
    else if (c.kind === "notice") lines.push(`[${c.text}]`);
  }
  let text = lines.join("\n\n");
  if (text.length > max) text = "…\n" + text.slice(-max);
  return text;
}

export async function answerAside(
  question: string,
  cells: Cell[],
  chatId: number | null,
  model?: { provider: string; name: string },
): Promise<string> {
  const { generateText } = await import("ai");
  const { readSettings } = await import("@/main/settings");
  const { getModelClient } = await import("@/ipc/utils/get_model_client");
  const { recordAuxUsage } = await import("@/lib/usage/turn-usage-aggregator");
  const settings = readSettings();
  const chosen = model ?? settings.selectedModel;
  // No key for the provider: getModelClient says so (it never moves to Core).
  const { modelClient } = await getModelClient(chosen, settings, { purpose: "summary" });
  const context = conversationText(cells);
  const result = await generateText({
    model: modelClient.model,
    system: BTW_SYSTEM,
    prompt: `${context ? `<conversation>\n${context}\n</conversation>\n\n` : ""}Side question: ${question}`,
    abortSignal: AbortSignal.timeout(BTW_TIMEOUT_MS),
  });
  recordAuxUsage(chatId, result.usage, "btw");
  return result.text.trim() || "No answer came back.";
}
