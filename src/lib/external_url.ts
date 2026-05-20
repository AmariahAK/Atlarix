const MAILTO_MAX_LENGTH = 8192;

/**
 * Validates URLs passed to shell.openExternal via open-external-url IPC.
 * @throws Error when the URL is not allowed
 */
export function validateOpenExternalUrl(url: string): void {
  if (!url || !url.trim()) {
    throw new Error("No URL provided.");
  }

  if (url.startsWith("mailto:")) {
    if (url.includes("\n") || url.includes("\r")) {
      throw new Error("Invalid mailto URL.");
    }
    if (url.length > MAILTO_MAX_LENGTH) {
      throw new Error("mailto URL is too long.");
    }
    return;
  }

  if (url.startsWith("http://") || url.startsWith("https://")) {
    return;
  }

  throw new Error("Attempted to open invalid or non-http URL: " + url);
}
