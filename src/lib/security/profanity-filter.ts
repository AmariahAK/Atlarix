import { SAFETY_FILTER_BLOCKED_MESSAGE } from "@/shared/texts";

/**
 * v10.1: in-house profanity filter — replaces the `bad-words` dependency
 * (it was the package's only use). Word-boundary matched, case-insensitive;
 * `clean` masks matches with asterisks like the original.
 */
const PROFANITY_WORDS = [
  "arsehole",
  "asshole",
  "bastard",
  "bitch",
  "bullshit",
  "cock",
  "cocksucker",
  "cunt",
  "dick",
  "dickhead",
  "dildo",
  "douchebag",
  "fag",
  "faggot",
  "fuck",
  "fucked",
  "fucker",
  "fucking",
  "jackass",
  "jerkoff",
  "motherfucker",
  "nigga",
  "nigger",
  "prick",
  "pussy",
  "shit",
  "shitty",
  "slut",
  "twat",
  "wanker",
  "whore",
];

const PROFANITY_RE = new RegExp(
  `\\b(?:${PROFANITY_WORDS.join("|")})\\b`,
  "gi",
);

function isProfane(text: string): boolean {
  PROFANITY_RE.lastIndex = 0;
  return PROFANITY_RE.test(text);
}

function cleanText(text: string): string {
  return text.replace(PROFANITY_RE, (m) => "*".repeat(m.length));
}

export class ChatPromptSafetyError extends Error {
  constructor(message: string = SAFETY_FILTER_BLOCKED_MESSAGE) {
    super(message);
    this.name = "ChatPromptSafetyError";
  }
}

export function assertUserMessageAllowed(text: string): void {
  if (isProfane(text)) {
    throw new ChatPromptSafetyError();
  }
}

/**
 * Run profanity clean on text outside ``` fenced blocks ``` so code samples stay intact.
 */
export function sanitizeAssistantOutput(text: string): string {
  const fenceRe = /```[\s\S]*?```/g;
  let last = 0;
  let out = "";
  let m: RegExpExecArray | null;
  const re = new RegExp(fenceRe.source, fenceRe.flags);
  while ((m = re.exec(text)) !== null) {
    out += cleanText(text.slice(last, m.index));
    out += m[0];
    last = m.index + m[0].length;
  }
  out += cleanText(text.slice(last));
  return out;
}
