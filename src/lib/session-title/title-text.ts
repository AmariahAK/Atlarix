/**
 * Session titles — the TEXT half: the prompt, sanitising what a model returns,
 * telling a title from a reply, and the no-model placeholder.
 *
 * Pure and dependency-free so main (which generates) and the renderer (which
 * shows the placeholder instantly) share one definition.
 *
 * WHY THIS WAS REWRITTEN (v14.52.0). DeepSeek V4 Pro titled "hey how are you?
 * could u tell me about yourself?" as "Hey! I'm doing well, thanks for asking.
 * 😊 I'm **DeepSeek V4 Pro**, running ins…" — it ANSWERED the transcript, and the
 * old path kept the first 80 characters. Three causes, all fixed here, following
 * what opencode, Codex CLI and Claude Code do:
 *   1. The prompt sent the assistant's REPLY too, which invites a chatty model to
 *      keep replying. Only the first user message goes in now.
 *   2. Nothing said "do not answer". Codex's prompt ends with exactly that.
 *   3. Nothing rejected a reply that came back anyway — `looksLikeReplyNotTitle`.
 */

import { isLowQualityGeneratedTitle } from "./title-quality";

/** Longest title shown; cut on a word boundary. */
export const TITLE_MAX_CHARS = 50;
/** First-message budget handed to the title model. */
const TITLE_INPUT_CHARS = 1_000;

export const TITLE_SYSTEM_PROMPT = `You generate a short title for a conversation. Output ONLY the title.

Rules:
- Name the user's task or topic in 6 words or fewer, 50 characters or fewer.
- Use the same language as the user's message.
- Do not answer the request. Do not greet, explain, or add commentary.
- No quotes, markdown, emoji, or trailing punctuation.
- If the message is only a greeting or small talk, output a short neutral label such as "Greeting".

Examples:
why does my useEffect run twice in dev -> React useEffect runs twice
hey how are you? could u tell me about yourself? -> Greeting and introduction
migrate the users table to postgres 16 -> Users table Postgres 16 migration`;

/**
 * What a session is named from. The terminal sends a paste as a placeholder
 * ("[Pasted text #1 +32 lines]") for display, and sessions came out named
 * "Pasted text with 32 lines"; the text sent to the model has the paste. Only
 * then: elsewhere the model text can hold whole attached files.
 */
export function titleSourceText(display: string, model: string): string {
  return /\[Pasted text #\d+/.test(display) && model.trim() ? model : display;
}

/** The user turn for the title model: the first user message ONLY. */
export function titleUserPrompt(firstUserText: string): string {
  return (
    "Generate a title for this conversation:\n<user_message>\n" +
    firstUserText.slice(0, TITLE_INPUT_CHARS) +
    "\n</user_message>"
  );
}

const EMOJI_RE = /[\p{Extended_Pictographic}\u{FE0F}\u{200D}]/gu;

/** Cut to `max` characters on a word boundary. */
function capOnWord(text: string, max = TITLE_MAX_CHARS): string {
  if (text.length <= max) return text;
  const cut = text.slice(0, max);
  const lastSpace = cut.lastIndexOf(" ");
  return (lastSpace > max * 0.5 ? cut.slice(0, lastSpace) : cut).trim();
}

/**
 * What a model returned → a candidate title. Keeps a trailing "?" on purpose:
 * a question is one of the signs `looksLikeReplyNotTitle` checks for.
 */
export function sanitizeGeneratedTitle(raw: string): string {
  let t = String(raw ?? "");
  // Reasoning a model leaked into its text — closed, then an unclosed tail.
  t = t.replace(/<think>[\s\S]*?<\/think>/gi, "");
  t = t.replace(/<think>[\s\S]*$/i, "");
  const trimmed = t.trim();
  if (trimmed.startsWith("{") && trimmed.endsWith("}")) {
    try {
      const parsed = JSON.parse(trimmed) as { title?: unknown };
      if (typeof parsed.title === "string") t = parsed.title;
    } catch {
      /* not JSON after all */
    }
  }
  const firstLine =
    t
      .split(/\r?\n/)
      .map((l) => l.trim())
      .find((l) => l.length > 0) ?? "";
  let out = firstLine
    .replace(/^(?:#+\s*|[-*•]\s+|\d+[.)]\s+)/, "")
    .replace(/^title\s*[:：-]\s*/i, "")
    .replace(/\*\*|__|`/g, "")
    .replace(EMOJI_RE, "")
    .replace(/\s+/g, " ")
    .trim();
  // Quotes and trailing punctuation wrap each other ("Title".), so peel both
  // until neither is left.
  for (let prev = ""; prev !== out; ) {
    prev = out;
    out = out
      .replace(/^["'“”‘’]+|["'“”‘’]+$/g, "")
      .replace(/[.:;,]+$/, "")
      .trim();
  }
  return capOnWord(out);
}

/**
 * True when a "title" is really the model replying to the user.
 *
 * Every rule is a failure actually observed in this app or listed in a
 * reference tool's changelog: a greeting, a first-person answer, a refusal, a
 * question back, a second sentence, the model naming itself.
 */
export function looksLikeReplyNotTitle(
  title: string,
  modelName?: string,
  /** The message being titled: a title about titles is fine when it asked for one. */
  userText?: string,
): boolean {
  const t = title.trim();
  if (!t) return true;
  // A model that wasn't writing a title: a safety classifier's verdict, or one
  // that titled the instruction ("Requested title generation") (QA 15.7.1 #12).
  if (/^(user\s+)?safety\b|^(safe|unsafe)$/i.test(t)) return true;
  if (/\btitles?\b/i.test(t) && userText != null && !/\btitle/i.test(userText)) {
    return true;
  }
  if (t.length > 60 || t.split(/\s+/).length > 8) return true;
  if (/[.!?]\s+\S/.test(t)) return true;
  if (t.endsWith("?")) return true;
  if (
    /^(hi|hey|hello|sure|certainly|of course|absolutely|okay|ok|great|thanks|thank you)\b/i.test(
      t,
    )
  ) {
    return true;
  }
  if (/\b(I|I'm|I am|I'll|I've|you|you're|your)\b/i.test(t)) return true;
  if (/^my\b/i.test(t)) return true;
  if (/\bas an ai\b|\bi can'?t\b|\bi cannot\b|\blanguage model\b/i.test(t)) {
    return true;
  }
  if (modelName) {
    const name = modelName.split("/").pop()!.replace(/[-_]/g, " ").trim();
    const head = name.split(" ")[0] ?? "";
    if (head.length >= 4 && t.toLowerCase().includes(head.toLowerCase())) {
      return true;
    }
  }
  return isLowQualityGeneratedTitle(t);
}

const BARE_GREETING_RE =
  /^(hi+|hey+|hello+|hiya|yo|sup|howdy|good (morning|afternoon|evening)|how are (you|u)|what'?s up)[\s!?.,]*$/i;
const LEADING_FILLER_RE =
  /^(hey+|hi+|hello+|yo|please|pls|so|ok(ay)?|can (you|u)|could (you|u)|would (you|u)|i need (you )?to|i want (you )?to|help me( to)?)\b[\s,!.:]*/i;

/**
 * A title from the first user message with no model call — shown IMMEDIATELY
 * as the placeholder, and kept if generation fails or returns a reply.
 * Returns null when there is nothing nameable (a message that was only an
 * attachment strips to nothing).
 */
export function deterministicTitle(firstUserText: string): string | null {
  const cleaned = String(firstUserText ?? "")
    .replace(/```[\s\S]*?(```|$)/g, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/`[^`]*`/g, " ")
    .replace(/https?:\/\/\S+/g, " ")
    .replace(/@\/?\S+/g, " ")
    .replace(/[*_#>|[\]]/g, " ");
  const line =
    cleaned
      .split(/\r?\n/)
      .map((l) => l.replace(/\s+/g, " ").trim())
      .find((l) => l.length > 0) ?? "";
  if (!line) return null;
  if (BARE_GREETING_RE.test(line)) return "Greeting";

  let rest = line;
  for (let i = 0; i < 4; i++) {
    const next = rest.replace(LEADING_FILLER_RE, "");
    if (next === rest) break;
    rest = next;
  }
  rest = rest.replace(EMOJI_RE, "").trim();
  // A quoted or listed line ("> fix", "- fix", "· fix", "› fix") names what it says.
  rest = rest.replace(/^\s*[›>·•*—–-]+\s*/, "");
  if (!rest || BARE_GREETING_RE.test(rest)) return "Greeting";

  const words = rest.split(" ").slice(0, 8).join(" ");
  const capped = capOnWord(words).replace(/[.,:;!?]+$/, "").trim();
  if (!capped) return null;
  return capped.charAt(0).toUpperCase() + capped.slice(1);
}

/** A title the app gives a session before it has a real one. */
export function isPlaceholderTitle(title: string): boolean {
  return /^(untitled|new chat|new conversation)( session)?$/i.test(title.trim());
}

/**
 * The name the chat header shows: the session's own title, never a placeholder
 * or the workspace's name (a new chat's tab starts with that, and the header
 * already says the workspace).
 */
export function chatHeaderTitle(tabTitle: string | undefined, workspaceName: string | undefined): string {
  const t = tabTitle?.trim() ?? "";
  return t && !isPlaceholderTitle(t) && t !== workspaceName?.trim() ? t : "";
}
