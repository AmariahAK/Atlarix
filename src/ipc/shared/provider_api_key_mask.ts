export type ProviderApiKeyStatus = {
  configured: boolean;
  preview?: string;
};

/** Mask API key for renderer display (last 4 chars visible). */
export function maskApiKeyPreview(apiKey: string): string {
  const trimmed = apiKey.trim();
  if (trimmed.length <= 4) {
    return "••••";
  }
  const visible = trimmed.slice(-4);
  return `${"•".repeat(Math.min(12, trimmed.length - 4))}${visible}`;
}

export function toProviderApiKeyStatus(apiKey: string | undefined): ProviderApiKeyStatus {
  if (!apiKey?.trim()) {
    return { configured: false };
  }
  return {
    configured: true,
    preview: maskApiKeyPreview(apiKey),
  };
}
