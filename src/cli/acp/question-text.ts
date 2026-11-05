/**
 * How a pending ask_user question goes to the editor: text for any editor
 * (`• label: description`), and `_meta.atlarix.question` for Atlarix's own
 * extension, which draws a card from it. The meta uses the wire shape (label
 * strings in `options`, full options in `choices`) because the extension and
 * this CLI can be different builds (`atlarix.cliPath`, PATH).
 */
import { toAskUserWire, type AskUserQuestion, type AskUserWireQuestion } from "@/lib/tools/ask_user_options";

export function questionText(items: readonly AskUserQuestion[]): string {
  const lines = items.map((q, i) => {
    const head = `${items.length > 1 ? `${i + 1}. ` : ""}${q.header ? `[${q.header}] ` : ""}${q.question}${q.multiSelect ? " (pick one or more)" : ""}`;
    const opts = (q.options ?? []).map(
      (o) => `\n   • ${o.label}${o.recommended ? " (recommended)" : ""}${o.description ? `: ${o.description}` : ""}`,
    );
    return head + opts.join("");
  });
  return `\n\n${lines.join("\n\n")}\n\n(Reply with your answer.)`;
}

export function questionMeta(items: readonly AskUserQuestion[]): { items: AskUserWireQuestion[] } {
  return { items: toAskUserWire(items) };
}
