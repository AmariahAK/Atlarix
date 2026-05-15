import { useState, useMemo, useEffect, useCallback } from "react";
import { AlertTriangle, Check, PlusIcon, Search, TrashIcon } from "lucide-react";
import { useQueryClient } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { CreateCustomModelDialog } from "@/components/CreateCustomModelDialog";
import { EditCustomModelDialog } from "@/components/EditCustomModelDialog";
import { useLanguageModelsForProvider } from "@/hooks/useLanguageModelsForProvider";
import { useDeleteCustomModel } from "@/hooks/useDeleteCustomModel";
import type { LanguageModel } from "@/ipc/ipc_types";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { cn } from "@/lib/utils";
import { useSettings } from "@/hooks/useSettings";
import type { LargeLanguageModel } from "@/lib/schemas";
import { TOKEN_COUNT_QUERY_KEY } from "@/hooks/useCountTokens";

const PAGE_SIZE = 7;

function languageModelToSelected(
  providerId: string,
  model: LanguageModel,
): LargeLanguageModel {
  return {
    name: model.apiName,
    provider: providerId,
    ...(model.type === "custom" ? { customModelId: model.id } : {}),
  };
}

function isSameChatModel(
  selected: LargeLanguageModel | undefined,
  providerId: string,
  model: LanguageModel,
): boolean {
  if (!selected) return false;
  if (selected.provider !== providerId || selected.name !== model.apiName) {
    return false;
  }
  if (model.type === "custom") {
    return selected.customModelId === model.id;
  }
  return selected.customModelId == null;
}

function filterModels(models: LanguageModel[], query: string): LanguageModel[] {
  const q = query.trim().toLowerCase();
  if (!q) return models;
  return models.filter(
    (m) =>
      m.displayName.toLowerCase().includes(q) ||
      m.apiName.toLowerCase().includes(q) ||
      (m.description && m.description.toLowerCase().includes(q)),
  );
}

interface ModelsSectionProps {
  providerId: string;
}

export function ModelsSection({ providerId }: ModelsSectionProps) {
  const { settings, updateSettings } = useSettings();
  const queryClient = useQueryClient();
  const [isCustomModelDialogOpen, setIsCustomModelDialogOpen] = useState(false);
  const [isEditModelDialogOpen, setIsEditModelDialogOpen] = useState(false);
  const [isConfirmDeleteDialogOpen, setIsConfirmDeleteDialogOpen] =
    useState(false);
  const [modelToDelete, setModelToDelete] = useState<string | null>(null);
  const [modelToEdit, setModelToEdit] = useState<{
    apiName: string;
    displayName: string;
    description?: string;
    maxOutputTokens?: number;
    contextWindow?: number;
    type: "custom";
    tag?: string;
  } | null>(null);
  const [searchQuery, setSearchQuery] = useState("");
  const [page, setPage] = useState(0);

  const {
    data: models,
    isLoading: modelsLoading,
    error: modelsError,
    refetch: refetchModels,
  } = useLanguageModelsForProvider(providerId);

  const filtered = useMemo(
    () => filterModels(models ?? [], searchQuery),
    [models, searchQuery],
  );

  const totalPages = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
  const safePage = Math.min(page, totalPages - 1);
  const pageSlice = filtered.slice(
    safePage * PAGE_SIZE,
    (safePage + 1) * PAGE_SIZE,
  );

  useEffect(() => {
    setPage(0);
  }, [searchQuery, providerId]);

  useEffect(() => {
    setPage((p) => Math.min(p, totalPages - 1));
  }, [totalPages]);

  const { mutate: deleteModel, isPending: isDeleting } = useDeleteCustomModel({
    onSuccess: () => {
      refetchModels();
    },
    onError: (error: Error) => {
      console.error("Failed to delete model:", error);
    },
  });

  const handleDeleteClick = (modelApiName: string) => {
    setModelToDelete(modelApiName);
    setIsConfirmDeleteDialogOpen(true);
  };

  const handleEditClick = (model: LanguageModel) => {
    if (model.type !== "custom") return;
    setModelToEdit({
      apiName: model.apiName,
      displayName: model.displayName,
      description: model.description,
      maxOutputTokens: model.maxOutputTokens,
      contextWindow: model.contextWindow,
      type: "custom",
      tag: model.tag,
    });
    setIsEditModelDialogOpen(true);
  };

  const applyAsChatModel = useCallback(
    async (model: LanguageModel) => {
      await updateSettings({
        selectedModel: languageModelToSelected(providerId, model),
      });
      queryClient.invalidateQueries({ queryKey: TOKEN_COUNT_QUERY_KEY });
    },
    [providerId, queryClient, updateSettings],
  );

  const handleModelRowActivate = (model: LanguageModel) => {
    void applyAsChatModel(model);
  };

  const handleModelDoubleClick = (model: LanguageModel) => {
    if (model.type === "custom") {
      handleEditClick(model);
    }
  };

  const handleConfirmDelete = () => {
    if (modelToDelete) {
      deleteModel({ providerId, modelApiName: modelToDelete });
      setModelToDelete(null);
    }
    setIsConfirmDeleteDialogOpen(false);
  };

  return (
    <div className="mt-8 border-t pt-6">
      <h2 className="text-2xl font-semibold mb-2">Models</h2>
      <p className="text-muted-foreground mb-4 text-sm">
        Browse built-in and custom models for this provider. Click a row or{" "}
        <span className="font-medium text-foreground">Use</span> to set the
        chat model. Use search and pagination for long lists.
      </p>

      {modelsLoading && (
        <div className="space-y-3 mt-4">
          <Skeleton className="h-10 w-full rounded-lg" />
          <Skeleton className="h-40 w-full rounded-lg" />
        </div>
      )}
      {modelsError && (
        <Alert variant="destructive" className="mt-4">
          <AlertTriangle className="h-4 w-4" />
          <AlertTitle>Error Loading Models</AlertTitle>
          <AlertDescription>{modelsError.message}</AlertDescription>
        </Alert>
      )}
      {!modelsLoading && !modelsError && models && models.length > 0 && (
        <div className="mt-4 space-y-3">
          <div className="relative max-w-md">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground pointer-events-none" />
            <Input
              placeholder="Search by name, id, or description…"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              className="pl-9"
              aria-label="Search models"
            />
          </div>
          <p className="text-xs text-muted-foreground">
            Showing {pageSlice.length ? safePage * PAGE_SIZE + 1 : 0}–
            {safePage * PAGE_SIZE + pageSlice.length} of {filtered.length}
            {models.length !== filtered.length
              ? ` (filtered from ${models.length})`
              : ""}
          </p>

          <div className="rounded-lg border border-border overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-border bg-muted/40 text-left">
                  <th className="px-3 py-2 font-medium">Name</th>
                  <th className="px-3 py-2 font-medium hidden sm:table-cell">
                    API id
                  </th>
                  <th className="px-3 py-2 font-medium whitespace-nowrap">
                    Type
                  </th>
                  <th className="px-3 py-2 font-medium hidden md:table-cell whitespace-nowrap">
                    Context
                  </th>
                  <th className="px-3 py-2 font-medium text-right w-[8rem]">
                    Actions
                  </th>
                </tr>
              </thead>
              <tbody>
                {pageSlice.map((model) => {
                  const rowSelected = isSameChatModel(
                    settings?.selectedModel,
                    providerId,
                    model,
                  );
                  return (
                  <tr
                    key={model.apiName + String(model.type)}
                    className={cn(
                      "border-b border-border/80 cursor-pointer transition-colors hover:bg-muted/30",
                      rowSelected && "bg-muted/50",
                    )}
                    onClick={() => handleModelRowActivate(model)}
                    onDoubleClick={() => handleModelDoubleClick(model)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter" || e.key === " ") {
                        e.preventDefault();
                        handleModelRowActivate(model);
                      }
                    }}
                    tabIndex={0}
                  >
                    <td className="px-3 py-2 align-top">
                      <div className="font-medium">{model.displayName}</div>
                      {model.description ? (
                        <div className="text-xs text-muted-foreground line-clamp-2 mt-0.5 max-w-[28rem]">
                          {model.description}
                        </div>
                      ) : null}
                      <div className="text-xs text-muted-foreground font-mono mt-1 sm:hidden truncate max-w-[12rem]">
                        {model.apiName}
                      </div>
                    </td>
                    <td className="px-3 py-2 align-top hidden sm:table-cell">
                      <span className="font-mono text-xs text-muted-foreground break-all">
                        {model.apiName}
                      </span>
                    </td>
                    <td className="px-3 py-2 align-top whitespace-nowrap">
                      <span
                        className={cn(
                          "inline-flex rounded-full px-2 py-0.5 text-[11px] font-medium",
                          model.type === "custom"
                            ? "bg-amber-500/15 text-amber-800 dark:text-amber-200"
                            : "bg-primary/10 text-primary",
                        )}
                      >
                        {model.type === "cloud" ? "Built-in" : model.type}
                      </span>
                      {model.tag ? (
                        <span className="ml-1 inline-flex rounded-full bg-muted px-2 py-0.5 text-[11px]">
                          {model.tag}
                        </span>
                      ) : null}
                    </td>
                    <td className="px-3 py-2 align-top hidden md:table-cell text-xs text-muted-foreground whitespace-nowrap">
                      {model.contextWindow != null
                        ? `${model.contextWindow.toLocaleString()} tok`
                        : "—"}
                    </td>
                    <td className="px-3 py-2 align-top text-right">
                      <div className="flex justify-end gap-1 flex-wrap">
                        <Button
                          type="button"
                          variant={rowSelected ? "secondary" : "outline"}
                          size="sm"
                          className="h-8 px-2"
                          onClick={(e) => {
                            e.stopPropagation();
                            void applyAsChatModel(model);
                          }}
                          aria-label={`Use ${model.displayName} as chat model`}
                        >
                          {rowSelected ? (
                            <Check className="h-4 w-4" aria-hidden />
                          ) : (
                            "Use"
                          )}
                        </Button>
                        {model.type === "custom" ? (
                          <>
                            <Button
                              variant="ghost"
                              size="icon"
                              className="h-8 w-8"
                              onClick={(e) => {
                                e.stopPropagation();
                                handleEditClick(model);
                              }}
                              aria-label={`Edit ${model.displayName}`}
                            >
                              <svg
                                className="h-4 w-4"
                                fill="none"
                                stroke="currentColor"
                                viewBox="0 0 24 24"
                                aria-hidden
                              >
                                <path
                                  strokeLinecap="round"
                                  strokeLinejoin="round"
                                  strokeWidth={2}
                                  d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z"
                                />
                              </svg>
                            </Button>
                            <Button
                              variant="ghost"
                              size="icon"
                              className="h-8 w-8 text-destructive hover:text-destructive"
                              onClick={(e) => {
                                e.stopPropagation();
                                handleDeleteClick(model.apiName);
                              }}
                              disabled={isDeleting}
                              aria-label={`Delete ${model.displayName}`}
                            >
                              <TrashIcon className="h-4 w-4" />
                            </Button>
                          </>
                        ) : null}
                      </div>
                    </td>
                  </tr>
                  );
                })}
              </tbody>
            </table>
          </div>

          {filtered.length === 0 ? (
            <p className="text-sm text-muted-foreground py-4 text-center">
              No models match your search.
            </p>
          ) : null}

          {totalPages > 1 ? (
            <div className="flex items-center justify-between gap-2 pt-2">
              <Button
                type="button"
                variant="outline"
                size="sm"
                disabled={safePage <= 0}
                onClick={() => setPage((p) => Math.max(0, p - 1))}
              >
                Previous
              </Button>
              <span className="text-xs text-muted-foreground tabular-nums">
                Page {safePage + 1} of {totalPages}
              </span>
              <Button
                type="button"
                variant="outline"
                size="sm"
                disabled={safePage >= totalPages - 1}
                onClick={() =>
                  setPage((p) => Math.min(totalPages - 1, p + 1))
                }
              >
                Next
              </Button>
            </div>
          ) : null}
        </div>
      )}
      {!modelsLoading && !modelsError && (!models || models.length === 0) && (
        <p className="text-muted-foreground mt-4 text-sm">
          No models are listed for this provider yet. Add a custom model below,
          or ensure your API key is saved so built-in models can load.
        </p>
      )}

      {providerId !== "auto" && (
        <Button
          onClick={() => setIsCustomModelDialogOpen(true)}
          variant="outline"
          className="mt-6"
        >
          <PlusIcon className="mr-2 h-4 w-4" /> Add Custom Model
        </Button>
      )}

      <CreateCustomModelDialog
        isOpen={isCustomModelDialogOpen}
        onClose={() => setIsCustomModelDialogOpen(false)}
        onSuccess={() => {
          setIsCustomModelDialogOpen(false);
          refetchModels();
        }}
        providerId={providerId}
      />

      <EditCustomModelDialog
        isOpen={isEditModelDialogOpen}
        onClose={() => setIsEditModelDialogOpen(false)}
        onSuccess={() => {
          setIsEditModelDialogOpen(false);
          refetchModels();
        }}
        providerId={providerId}
        model={modelToEdit}
      />

      <AlertDialog
        open={isConfirmDeleteDialogOpen}
        onOpenChange={setIsConfirmDeleteDialogOpen}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              Are you sure you want to delete this model?
            </AlertDialogTitle>
            <AlertDialogDescription>
              This action cannot be undone. This will permanently delete the
              custom model "
              {modelToDelete
                ? models?.find((m) => m.apiName === modelToDelete)
                    ?.displayName || modelToDelete
                : ""}
              " (API Name: {modelToDelete}).
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel onClick={() => setModelToDelete(null)}>
              Cancel
            </AlertDialogCancel>
            <AlertDialogAction
              onClick={handleConfirmDelete}
              className="bg-red-600 hover:bg-red-700"
            >
              {isDeleting ? "Deleting..." : "Yes, delete it"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
