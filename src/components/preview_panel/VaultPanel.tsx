/**
 * VaultPanel - Per-workspace environment variables (Vault)
 * Syncs to .env.local in the workspace. Shown in right panel Vault tab.
 */

import { useState, useCallback } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { KeyRound, Plus, Save, X, Edit2, Trash2 } from "lucide-react";
import { showError, showSuccess } from "@/lib/toast";
import { IpcClient } from "@/ipc/ipc_client";

interface VaultPanelProps {
  appId: number | null;
}

export function VaultPanel({ appId }: VaultPanelProps) {
  const queryClient = useQueryClient();
  const [editingKey, setEditingKey] = useState<string | null>(null);
  const [editingKeyValue, setEditingKeyValue] = useState("");
  const [editingValue, setEditingValue] = useState("");
  const [newKey, setNewKey] = useState("");
  const [newValue, setNewValue] = useState("");
  const [isAddingNew, setIsAddingNew] = useState(false);

  const {
    data: envVars = [],
    isLoading,
    error,
  } = useQuery({
    queryKey: ["app-env-vars", appId],
    queryFn: async () => {
      if (!appId) return [];
      return await IpcClient.getInstance().getAppEnvVars({ appId });
    },
    enabled: !!appId,
  });

  const saveEnvVarsMutation = useMutation({
    mutationFn: async (newEnvVars: { key: string; value: string }[]) => {
      if (!appId) throw new Error("No workspace selected");
      return await IpcClient.getInstance().setAppEnvVars({
        appId,
        envVars: newEnvVars,
      });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["app-env-vars", appId] });
      showSuccess("Environment variables saved to .env.local");
    },
    onError: (err) => {
      showError(`Failed to save: ${err instanceof Error ? err.message : "Unknown error"}`);
    },
  });

  const handleAdd = useCallback(() => {
    if (!newKey.trim() || !newValue.trim()) {
      showError("Both key and value are required");
      return;
    }
    if (envVars.some((ev) => ev.key === newKey.trim())) {
      showError("Key already exists");
      return;
    }
    saveEnvVarsMutation.mutate([
      ...envVars,
      { key: newKey.trim(), value: newValue.trim() },
    ]);
    setNewKey("");
    setNewValue("");
    setIsAddingNew(false);
  }, [newKey, newValue, envVars, saveEnvVarsMutation]);

  const handleEdit = useCallback((envVar: { key: string; value: string }) => {
    setEditingKey(envVar.key);
    setEditingKeyValue(envVar.key);
    setEditingValue(envVar.value);
  }, []);

  const handleSaveEdit = useCallback(() => {
    if (!editingKeyValue.trim() || !editingValue.trim()) {
      showError("Both key and value are required");
      return;
    }
    if (
      envVars.some(
        (ev) => ev.key === editingKeyValue.trim() && ev.key !== editingKey
      )
    ) {
      showError("Key already exists");
      return;
    }
    const next = envVars.map((ev) =>
      ev.key === editingKey
        ? { key: editingKeyValue.trim(), value: editingValue.trim() }
        : ev
    );
    saveEnvVarsMutation.mutate(next);
    setEditingKey(null);
    setEditingKeyValue("");
    setEditingValue("");
  }, [editingKey, editingKeyValue, editingValue, envVars, saveEnvVarsMutation]);

  const handleCancelEdit = useCallback(() => {
    setEditingKey(null);
    setEditingKeyValue("");
    setEditingValue("");
  }, []);

  const handleDelete = useCallback(
    (key: string) => {
      saveEnvVarsMutation.mutate(envVars.filter((ev) => ev.key !== key));
    },
    [envVars, saveEnvVarsMutation]
  );

  if (!appId) {
    return (
      <div className="flex flex-col items-center justify-center h-full text-muted-foreground p-6 text-center">
        <KeyRound className="w-12 h-12 mb-3 opacity-50" />
        <p className="text-sm font-medium">Vault</p>
        <p className="text-xs mt-1">Select a workspace to manage environment variables</p>
        <p className="text-xs mt-2 opacity-80">Stored in .env.local</p>
      </div>
    );
  }

  if (isLoading) {
    return (
      <div className="flex flex-col items-center justify-center h-full text-muted-foreground p-6">
        <p className="text-sm">Loading environment variables...</p>
      </div>
    );
  }

  if (error) {
    return (
      <div className="p-4 text-center">
        <p className="text-sm text-destructive">
          {error instanceof Error ? error.message : "Failed to load"}
        </p>
      </div>
    );
  }

  return (
    <div className="flex flex-col h-full">
      <div className="flex items-center gap-2 px-3 py-2 border-b border-border">
        <KeyRound className="w-4 h-4 text-amber-500" />
        <span className="text-sm font-medium">Vault</span>
        <span className="text-xs text-muted-foreground">.env.local</span>
      </div>
      <div className="flex-1 overflow-auto p-3 space-y-3">
        {isAddingNew ? (
          <div className="space-y-2 p-3 border rounded-md bg-muted/50">
            <Label className="text-xs">Key</Label>
            <Input
              placeholder="e.g. API_KEY"
              value={newKey}
              onChange={(e) => setNewKey(e.target.value)}
              className="h-8"
            />
            <Label className="text-xs">Value</Label>
            <Input
              placeholder="(secret)"
              type="password"
              value={newValue}
              onChange={(e) => setNewValue(e.target.value)}
              className="h-8"
            />
            <div className="flex gap-2">
              <Button size="sm" onClick={handleAdd} disabled={saveEnvVarsMutation.isPending}>
                <Save className="h-3.5 w-3.5 mr-1" />
                Save
              </Button>
              <Button
                size="sm"
                variant="outline"
                onClick={() => {
                  setIsAddingNew(false);
                  setNewKey("");
                  setNewValue("");
                }}
              >
                <X className="h-3.5 w-3.5 mr-1" />
                Cancel
              </Button>
            </div>
          </div>
        ) : (
          <Button
            variant="outline"
            size="sm"
            className="w-full"
            onClick={() => setIsAddingNew(true)}
          >
            <Plus className="h-4 w-4 mr-2" />
            Add variable
          </Button>
        )}

        <div className="space-y-2">
          {envVars.length === 0 ? (
            <p className="text-xs text-muted-foreground text-center py-4">
              No variables. Add one to sync to .env.local.
            </p>
          ) : (
            envVars.map((envVar) => (
              <div
                key={envVar.key}
                className="flex items-center gap-2 p-2 border rounded-md bg-background"
              >
                {editingKey === envVar.key ? (
                  <>
                    <div className="flex-1 space-y-1 min-w-0">
                      <Input
                        value={editingKeyValue}
                        onChange={(e) => setEditingKeyValue(e.target.value)}
                        placeholder="Key"
                        className="h-7 text-xs"
                      />
                      <Input
                        value={editingValue}
                        onChange={(e) => setEditingValue(e.target.value)}
                        placeholder="Value"
                        type="password"
                        className="h-7 text-xs"
                      />
                    </div>
                    <Button size="sm" variant="ghost" className="h-7 w-7 p-0" onClick={handleSaveEdit}>
                      <Save className="h-3.5 w-3.5" />
                    </Button>
                    <Button size="sm" variant="ghost" className="h-7 w-7 p-0" onClick={handleCancelEdit}>
                      <X className="h-3.5 w-3.5" />
                    </Button>
                  </>
                ) : (
                  <>
                    <div className="flex-1 min-w-0">
                      <p className="text-sm font-medium truncate">{envVar.key}</p>
                      <p className="text-xs text-muted-foreground truncate">
                        {envVar.value ? "••••••••" : "(empty)"}
                      </p>
                    </div>
                    <Button
                      size="sm"
                      variant="ghost"
                      className="h-7 w-7 p-0"
                      onClick={() => handleEdit(envVar)}
                    >
                      <Edit2 className="h-3.5 w-3.5" />
                    </Button>
                    <Button
                      size="sm"
                      variant="ghost"
                      className="h-7 w-7 p-0 text-destructive hover:text-destructive"
                      onClick={() => handleDelete(envVar.key)}
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                    </Button>
                  </>
                )}
              </div>
            ))
          )}
        </div>
      </div>
    </div>
  );
}
