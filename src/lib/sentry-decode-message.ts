/** Decode Sentry messages stored as comma-separated char codes (e.g. "105,110,118"). */
export function decodeSentryCharCodeMessage(message: string): string {
  const trimmed = message.trim();
  if (!/^\d+(,\d+)+$/.test(trimmed)) return message;
  try {
    return trimmed
      .split(",")
      .map((n) => String.fromCharCode(Number(n)))
      .join("");
  } catch {
    return message;
  }
}

export function normalizeSentryErrorText(text: string): string {
  return decodeSentryCharCodeMessage(text);
}
