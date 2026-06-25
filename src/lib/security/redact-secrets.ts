/**
 * D1 — conservative secret redaction (display + logs safety net).
 *
 * Masks ONLY high-confidence credential shapes (unambiguous provider key/token
 * prefixes + JWTs + PEM private-key blocks). We deliberately do NOT mask generic
 * long alphanumerics, hashes, or UUIDs — over-redaction would hide data the
 * model/user legitimately needs. This is a safety net behind the prompt rule
 * ("never print full secret values"), applied to the DISPLAY copy of tool output
 * and to log lines — never to the model-facing tool result.
 */

const SECRET_PATTERNS: RegExp[] = [
  // OpenAI (incl. project keys) + Anthropic
  /\bsk-(?:ant-|proj-)?[A-Za-z0-9_-]{20,}\b/g,
  // GitHub tokens (classic + fine-grained PAT)
  /\bgh[pousr]_[A-Za-z0-9]{36,}\b/g,
  /\bgithub_pat_[A-Za-z0-9_]{22,}\b/g,
  // AWS access key id
  /\bAKIA[0-9A-Z]{16}\b/g,
  // Google API key
  /\bAIza[0-9A-Za-z_-]{35}\b/g,
  // Slack tokens
  /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g,
  // JSON Web Token (header.payload.signature)
  /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g,
  // PEM private key blocks
  /-----BEGIN[A-Z ]*PRIVATE KEY-----[\s\S]*?-----END[A-Z ]*PRIVATE KEY-----/g,
];

const REDACTION = "[redacted secret]";

/** Replace high-confidence secret shapes in `text` with a placeholder. */
export function redactSecretsInText(text: string): string {
  if (!text) return text;
  let out = text;
  for (const re of SECRET_PATTERNS) {
    out = out.replace(re, REDACTION);
  }
  return out;
}

/** True if `text` contains at least one high-confidence secret shape. */
export function containsSecret(text: string): boolean {
  return SECRET_PATTERNS.some((re) => {
    re.lastIndex = 0;
    return re.test(text);
  });
}
