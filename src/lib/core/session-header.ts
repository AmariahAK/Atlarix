/**
 * `X-Atlarix-Session`: an opaque id per chat, sent on every Atlarix Core request
 * of that chat (main turn, sub-agents, title, compaction), so the proxy can keep
 * one chat on one provider and count abuse per chat (contract with ai-34/ai-dd,
 * 2026-10-29).
 *
 * HMAC-SHA256(per-install secret, chat id), first 32 lowercase hex characters:
 * never derived from anything readable, stable for the chat (the app, the CLI
 * and the editors share one profile, so a chat resumed on another surface sends
 * the same value), and new for a fork or a new chat, which get new ids. No
 * database column: the secret is one file in the shared user-data folder.
 *
 * A cloud-agent or Slack run starts on a fresh profile every turn, so its secret
 * would change each turn. Its server derives the id per thread and hands it in
 * as `ATLARIX_CORE_SESSION`, which wins when it is 32 lowercase hex characters.
 */
import { createHmac, randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { getUserDataPath } from "@/paths/paths";

const HEX32 = /^[0-9a-f]{32}$/;

let secret: string | null = null;

function installSecret(): string | null {
  if (secret) return secret;
  try {
    const file = path.join(getUserDataPath(), "core-session.key");
    try {
      const existing = fs.readFileSync(file, "utf8").trim();
      if (/^[0-9a-f]{64}$/.test(existing)) return (secret = existing);
    } catch {
      // First use on this install: made below.
    }
    const made = randomBytes(32).toString("hex");
    fs.mkdirSync(path.dirname(file), { recursive: true });
    // `wx`: if another process made it first, theirs wins and is read back.
    try {
      fs.writeFileSync(file, made, { flag: "wx", mode: 0o600 });
      return (secret = made);
    } catch {
      const theirs = fs.readFileSync(file, "utf8").trim();
      return /^[0-9a-f]{64}$/.test(theirs) ? (secret = theirs) : null;
    }
  } catch {
    return null;
  }
}

/** The session id for this chat, or null (no chat, or no secret could be kept). */
export function coreSessionId(chatId: number | string | null | undefined, env: NodeJS.ProcessEnv = process.env): string | null {
  const given = env.ATLARIX_CORE_SESSION?.trim();
  if (given && HEX32.test(given)) return given;
  if (chatId == null || chatId === "") return null;
  const key = installSecret();
  if (!key) return null;
  return createHmac("sha256", key).update(String(chatId)).digest("hex").slice(0, 32);
}

/** Test-only. */
export function __setCoreSessionSecretForTests(value: string | null): void {
  secret = value;
}
