import { useEffect, useState } from "react";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { KeyRound } from "lucide-react";
import type { UserSettings } from "@/lib/schemas";

interface ElasticSettings {
  baseUrl?: string;
  apiKey?: { value?: string };
  space?: string;
}

interface ElasticConfigurationProps {
  settings: UserSettings | null | undefined;
  updateSettings: (settings: Partial<UserSettings>) => Promise<UserSettings>;
}

export function ElasticConfiguration({
  settings,
  updateSettings,
}: ElasticConfigurationProps) {
  const existing = (settings?.providerSettings?.elastic as ElasticSettings | undefined) ?? {};
  const existingBaseUrl = existing.baseUrl ?? "";
  const existingApiKey = existing.apiKey?.value ?? "";
  const existingSpace = existing.space ?? "";

  const [baseUrl, setBaseUrl] = useState(existingBaseUrl);
  const [apiKey, setApiKey] = useState(existingApiKey);
  const [space, setSpace] = useState(existingSpace);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setBaseUrl(existingBaseUrl);
    setApiKey(existingApiKey);
    setSpace(existingSpace);
  }, [existingBaseUrl, existingApiKey, existingSpace]);

  const isConfigured = Boolean(baseUrl.trim() && apiKey.trim());

  const handleSave = async () => {
    setSaving(true);
    setError(null);
    try {
      const trimmedBaseUrl = baseUrl.trim();
      const trimmedApiKey = apiKey.trim();
      const trimmedSpace = space.trim();
      if (!trimmedBaseUrl) {
        setError("Kibana URL is required.");
        return;
      }
      if (!trimmedApiKey) {
        setError("API key is required.");
        return;
      }
      await updateSettings({
        providerSettings: {
          ...settings?.providerSettings,
          elastic: {
            baseUrl: trimmedBaseUrl,
            apiKey: { value: trimmedApiKey },
            space: trimmedSpace || undefined,
          },
        },
      });
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : "Failed to save Elastic Agent Builder settings");
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="space-y-4 mt-6">
      {isConfigured && (
        <Alert className="border-emerald-500/30 bg-emerald-500/5">
          <KeyRound className="h-4 w-4 text-emerald-600" />
          <AlertTitle>Elastic Agent Builder configured</AlertTitle>
          <AlertDescription>
            Kibana URL and API key are set. You can list agents as models after refreshing.
          </AlertDescription>
        </Alert>
      )}
      <div className="space-y-2">
        <Label htmlFor="elastic-base-url">Kibana URL</Label>
        <Input
          id="elastic-base-url"
          type="url"
          value={baseUrl}
          onChange={(e) => setBaseUrl(e.target.value)}
          placeholder="https://your-deployment.kb.us-central1.gcp.cloud.es.io"
        />
        <p className="text-xs text-muted-foreground">
          Your Kibana base URL (e.g. Elastic Cloud or self-hosted). Agent Builder must be enabled.
        </p>
      </div>
      <div className="space-y-2">
        <Label htmlFor="elastic-api-key">API Key</Label>
        <Input
          id="elastic-api-key"
          type="password"
          value={apiKey}
          onChange={(e) => setApiKey(e.target.value)}
          placeholder="Elastic / Kibana API key"
        />
        <p className="text-xs text-muted-foreground">
          Create an API key in Kibana (search &quot;API keys&quot; in the global search bar).
        </p>
      </div>
      <div className="space-y-2">
        <Label htmlFor="elastic-space">Space (optional)</Label>
        <Input
          id="elastic-space"
          type="text"
          value={space}
          onChange={(e) => setSpace(e.target.value)}
          placeholder="default"
        />
        <p className="text-xs text-muted-foreground">
          Kibana space ID if not using the default space.
        </p>
      </div>
      {error && (
        <Alert variant="destructive">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}
      <Button onClick={handleSave} disabled={saving || !baseUrl.trim() || !apiKey.trim()}>
        {saving ? "Saving..." : "Save"}
      </Button>
    </div>
  );
}
