import React, { useState, useEffect } from "react";
import { useTranslation } from "react-i18next";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Loader2 } from "lucide-react";
import { useCustomLanguageModelProvider } from "@/hooks/useCustomLanguageModelProvider";
import type { CustomApiFormat, LanguageModelProvider } from "@/ipc/ipc_types";

const API_FORMATS = [
  { id: "openai", labelKey: "providers.apiFormatOpenAi" },
  { id: "anthropic", labelKey: "providers.apiFormatAnthropic" },
] as const satisfies ReadonlyArray<{ id: CustomApiFormat; labelKey: string }>;

interface CreateCustomProviderDialogProps {
  isOpen: boolean;
  onClose: () => void;
  onSuccess: () => void;
  editingProvider?: LanguageModelProvider | null;
}

export function CreateCustomProviderDialog({
  isOpen,
  onClose,
  onSuccess,
  editingProvider = null,
}: CreateCustomProviderDialogProps) {
  const { t } = useTranslation("settings");
  const [id, setId] = useState("");
  const [name, setName] = useState("");
  const [apiBaseUrl, setApiBaseUrl] = useState("");
  const [envVarName, setEnvVarName] = useState("");
  const [apiFormat, setApiFormat] = useState<CustomApiFormat>("openai");
  const [errorMessage, setErrorMessage] = useState("");
  const isEditMode = Boolean(editingProvider);

  const { createProvider, editProvider, isCreating, isEditing, error } =
    useCustomLanguageModelProvider();
  // Load provider data when editing
  useEffect(() => {
    if (editingProvider && isOpen) {
      const cleanId = editingProvider.id?.startsWith("custom::")
        ? editingProvider.id.replace("custom::", "")
        : editingProvider.id || "";
      setId(cleanId);
      setName(editingProvider.name || "");
      setApiBaseUrl(editingProvider.apiBaseUrl || "");
      setEnvVarName(editingProvider.envVarName || "");
      setApiFormat(editingProvider.apiFormat ?? "openai");
    } else if (!isOpen) {
      // Reset form when dialog closes
      setId("");
      setName("");
      setApiBaseUrl("");
      setEnvVarName("");
      setApiFormat("openai");
      setErrorMessage("");
    }
  }, [editingProvider, isOpen]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setErrorMessage("");

    try {
      if (isEditMode && editingProvider) {
        const cleanId = editingProvider.id?.startsWith("custom::")
          ? editingProvider.id.replace("custom::", "")
          : editingProvider.id || "";
        await editProvider({
          id: cleanId,
          name: name.trim(),
          apiBaseUrl: apiBaseUrl.trim(),
          envVarName: envVarName.trim() || undefined,
          apiFormat,
        });
      } else {
        await createProvider({
          id: id.trim(),
          name: name.trim(),
          apiBaseUrl: apiBaseUrl.trim() || "https://manual.provider",
          envVarName: envVarName.trim() || undefined,
          apiFormat,
        });
      }

      // Reset form
      setId("");
      setName("");
      setApiBaseUrl("");
      setEnvVarName("");
      setApiFormat("openai");

      onSuccess();
    } catch (error) {
      setErrorMessage(
        error instanceof Error
          ? error.message
          : `Failed to ${isEditMode ? "edit" : "create"} custom provider`,
      );
    }
  };

  const handleClose = () => {
    if (!isCreating && !isEditing) {
      setErrorMessage("");
      onClose();
    }
  };
  const isLoading = isCreating || isEditing;

  return (
    <Dialog open={isOpen} onOpenChange={handleClose}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>
            {isEditMode ? "Edit Custom Provider" : "Add Custom Provider"}
          </DialogTitle>
          <DialogDescription>
            {isEditMode
              ? "Update your custom language model provider configuration."
              : apiFormat === "anthropic"
                ? t("providers.apiFormatAnthropicDescription")
                : "An OpenAI-compatible endpoint."}
          </DialogDescription>
        </DialogHeader>

        <form onSubmit={handleSubmit} className="space-y-4 pt-4">
          <div className="space-y-2">
            <Label htmlFor="id">Provider ID</Label>
            <Input
              id="id"
              value={id}
              onChange={(e) => setId(e.target.value)}
              placeholder="E.g., my-provider"
              required
              disabled={isLoading || isEditMode}
            />
          </div>

          <div className="space-y-2">
            <Label htmlFor="name">Display Name</Label>
            <Input
              id="name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="E.g., My Provider"
              required
              disabled={isLoading}
            />
          </div>

          <div className="space-y-2">
            <Label id="apiFormatLabel">{t("providers.apiFormat")}</Label>
            <div
              role="radiogroup"
              aria-labelledby="apiFormatLabel"
              className="flex gap-2"
            >
              {API_FORMATS.map((f) => (
                <Button
                  key={f.id}
                  type="button"
                  role="radio"
                  aria-checked={apiFormat === f.id}
                  variant={apiFormat === f.id ? "default" : "outline"}
                  size="sm"
                  onClick={() => setApiFormat(f.id)}
                  disabled={isLoading}
                >
                  {t(f.labelKey)}
                </Button>
              ))}
            </div>
          </div>

          <div className="space-y-2">
            <Label htmlFor="apiBaseUrl">
              API Base URL (optional for manual providers)
            </Label>
            <Input
              id="apiBaseUrl"
              value={apiBaseUrl}
              onChange={(e) => setApiBaseUrl(e.target.value)}
              placeholder="E.g., https://api.example.com/v1 (or placeholder if no endpoint)"
              disabled={isLoading}
            />
            <p className="text-xs text-muted-foreground">
              {apiFormat === "anthropic"
                ? t("providers.apiFormatAnthropicBaseUrlHint")
                : "e.g. http://127.0.0.1:11434/v1"}
            </p>
          </div>

          <div className="space-y-2">
            <Label htmlFor="envVarName">Environment Variable (Optional)</Label>
            <Input
              id="envVarName"
              value={envVarName}
              onChange={(e) => setEnvVarName(e.target.value)}
              placeholder="E.g., MY_PROVIDER_API_KEY"
              disabled={isLoading}
            />
            <p className="text-xs text-muted-foreground">
              Environment variable name for the API key.
            </p>
          </div>

          {(errorMessage || error) && (
            <div className="text-sm text-red-500">
              {errorMessage ||
                (error instanceof Error
                  ? error.message
                  : "Failed to create custom provider")}
            </div>
          )}

          <div className="flex justify-end gap-2">
            <Button
              type="button"
              variant="outline"
              onClick={handleClose}
              disabled={isLoading}
            >
              Cancel
            </Button>
            <Button type="submit" disabled={isLoading}>
              {isLoading && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
              {isLoading
                ? isEditMode
                  ? "Updating..."
                  : "Adding..."
                : isEditMode
                  ? "Update Provider"
                  : "Add Provider"}
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}
