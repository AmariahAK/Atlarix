import { KeyRound, Trash2, Clipboard } from "lucide-react";
import { keyHint } from "@/lib/provider-key-check";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import {
  Accordion,
  AccordionContent,
  AccordionItem,
  AccordionTrigger,
} from "@/components/ui/accordion";
import { AzureConfiguration } from "./AzureConfiguration";
import { VertexConfiguration } from "./VertexConfiguration";
import { ElasticConfiguration } from "./ElasticConfiguration";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { UserSettings } from "@/lib/schemas";
import { Tooltip, TooltipContent, TooltipTrigger } from "../ui/tooltip";
import { showError } from "@/lib/toast";

interface ApiKeyConfigurationProps {
  provider: string;
  providerDisplayName: string;
  settings: UserSettings | null | undefined;
  envVars: Record<string, string | undefined>;
  envVarName?: string;
  isSaving: boolean;
  saveError: string | null;
  apiKeyInput: string;
  onApiKeyInputChange: (value: string) => void;
  onSaveKey: (value: string) => Promise<void>;
  onDeleteKey: () => Promise<void>;
  updateSettings: (settings: Partial<UserSettings>) => Promise<UserSettings>;
}

export function ApiKeyConfiguration({
  provider,
  providerDisplayName,
  settings,
  envVars,
  envVarName: _envVarName,
  isSaving,
  saveError,
  apiKeyInput,
  onApiKeyInputChange,
  onSaveKey,
  onDeleteKey,
  updateSettings,
}: ApiKeyConfigurationProps) {
  // Special handling for Azure OpenAI which requires environment variables
  if (provider === "azure") {
    return (
      <AzureConfiguration
        settings={settings}
        envVars={envVars}
        updateSettings={updateSettings}
      />
    );
  }
  // Special handling for Google Vertex AI which uses service account credentials
  if (provider === "vertex") {
    return <VertexConfiguration />;
  }
  // Elastic Agent Builder: Kibana URL + API key + optional space
  if (provider === "elastic") {
    return (
      <ElasticConfiguration
        settings={settings}
        updateSettings={updateSettings}
      />
    );
  }

  const userApiKey = settings?.providerSettings?.[provider]?.apiKey?.value;

  const isValidUserKey =
    !!userApiKey &&
    !userApiKey.startsWith("Invalid Key") &&
    userApiKey !== "Not Set";
  const defaultAccordionValue = [];
  defaultAccordionValue.push("settings-key");

  return (
    <Accordion
      type="multiple"
      className="w-full space-y-4"
      defaultValue={defaultAccordionValue}
    >
      <AccordionItem
        value="settings-key"
        className="border rounded-lg px-4 bg-(--background-lightest)"
      >
        <AccordionTrigger className="text-lg font-medium hover:no-underline cursor-pointer">
          API Key from Settings
        </AccordionTrigger>
        <AccordionContent className="pt-4 ">
          {isValidUserKey && (
            <Alert variant="default" className="mb-4">
              <KeyRound className="h-4 w-4" />
              <AlertTitle className="flex justify-between items-center">
                <span>Current Key (Settings)</span>
                <Button
                  variant="destructive"
                  size="sm"
                  onClick={onDeleteKey}
                  disabled={isSaving}
                  className="flex items-center gap-1 h-7 px-2"
                >
                  <Trash2 className="h-4 w-4" />
                  {isSaving ? "Deleting..." : "Delete"}
                </Button>
              </AlertTitle>
              <AlertDescription>
                {/* Masked: the page printed the whole key (QA #24). */}
                <p className="font-mono text-sm">{keyHint(userApiKey)}</p>
              </AlertDescription>
            </Alert>
          )}

          <div className="space-y-2">
            <label
              htmlFor="apiKeyInput"
              className="block text-sm font-medium text-gray-700 dark:text-gray-300"
            >
              {isValidUserKey ? "Update" : "Set"} {providerDisplayName} API Key
            </label>
            <div className="flex items-start space-x-2">
              <Input
                id="apiKeyInput"
                type="password"
                autoComplete="off"
                value={apiKeyInput}
                onChange={(e) => onApiKeyInputChange(e.target.value)}
                placeholder={`Enter new ${providerDisplayName} API Key here`}
                className={`flex-grow ${saveError ? "border-red-500" : ""}`}
              />
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button
                    onClick={async () => {
                      try {
                        const text = await navigator.clipboard.readText();
                        if (text) {
                          onSaveKey(text);
                        }
                      } catch (error) {
                        showError("Failed to paste from clipboard");
                        console.error("Failed to paste from clipboard", error);
                      }
                    }}
                    disabled={isSaving}
                    variant="outline"
                    size="icon"
                    title="Paste from clipboard and save"
                    aria-label="Paste from clipboard and save"
                  >
                    <Clipboard className="h-4 w-4" />
                  </Button>
                </TooltipTrigger>
                <TooltipContent>Paste from clipboard and save</TooltipContent>
              </Tooltip>

              <Button
                onClick={() => onSaveKey(apiKeyInput)}
                disabled={isSaving || !apiKeyInput}
              >
                {isSaving ? "Saving..." : "Save Key"}
              </Button>
            </div>
            {saveError && <p className="text-xs text-red-600">{saveError}</p>}
            <p className="text-xs text-gray-500 dark:text-gray-400">
              Setting a key here will override the environment variable (if
              set).
            </p>
          </div>
        </AccordionContent>
      </AccordionItem>
    </Accordion>
  );
}
