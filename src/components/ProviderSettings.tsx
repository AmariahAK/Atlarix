import {
  Card,
  CardHeader,
  CardTitle,
  CardDescription,
} from "@/components/ui/card";
import { useTranslation } from "react-i18next";
import { useAtomValue } from "jotai";
import { providerKeyCheckAtom } from "@/atoms/viewAtoms";
import { useNavigate } from "@tanstack/react-router";
import type { LanguageModelProvider } from "@/ipc/ipc_types";

import { useLanguageModelProviders } from "@/hooks/useLanguageModelProviders";
import { useCustomLanguageModelProvider } from "@/hooks/useCustomLanguageModelProvider";
import {
  GiftIcon,
  PlusIcon,
  Trash2,
  Edit,
} from "lucide-react";
import { Skeleton } from "./ui/skeleton";
import { Alert, AlertDescription, AlertTitle } from "./ui/alert";
import { AlertTriangle } from "lucide-react";
import { useMemo, useState, useEffect, useCallback } from "react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
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
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";

import { CreateCustomProviderDialog } from "./CreateCustomProviderDialog";
import { cn } from "@/lib/utils";

const COMPASS_ID = "compass";
const OPENROUTER_ID = "openrouter";
const PAGE_SIZE = 6;

function shuffleArray<T>(items: T[]): T[] {
  const a = [...items];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function filterProviders(
  list: LanguageModelProvider[],
  query: string,
): LanguageModelProvider[] {
  const q = query.trim().toLowerCase();
  if (!q) return list;
  return list.filter(
    (p) => p.name.toLowerCase().includes(q) || p.id.toLowerCase().includes(q),
  );
}

/**
 * The grid's order: Core, then OpenRouter, then the rest in a STABLE shuffle —
 * all of it narrowed by the query. Exported for the regression test.
 */
export function orderProvidersForPaging(
  filtered: LanguageModelProvider[],
  shuffledNonCompass: LanguageModelProvider[],
  searchQuery: string,
  /** The ones you set up come first: "5 providers configured" used to be
   * scattered across 37 shuffled pages (QA #31). */
  isSetUp?: (id: string) => boolean,
): LanguageModelProvider[] {
  const compass = filtered.find((p) => p.id === COMPASS_ID);
  const openrouter = filtered.find((p) => p.id === OPENROUTER_ID);
  const q = searchQuery.trim().toLowerCase();
  const compassVisible =
    compass &&
    (!q ||
      compass.name.toLowerCase().includes(q) ||
      compass.id.toLowerCase().includes(q));
  // OpenRouter is pinned once you've set it up; unconfigured it sorts with the
  // rest, not ahead of the providers you use (QA #31).
  const openrouterVisible =
    openrouter &&
    (!isSetUp || isSetUp(openrouter.id)) &&
    (!q ||
      openrouter.name.toLowerCase().includes(q) ||
      openrouter.id.toLowerCase().includes(q));

  // THE QUERY FILTERS THE TAIL TOO. The shuffle is kept off the query (see
  // `reshuffleForDisplay`) — but the shuffled list is the UNFILTERED lineup, so taking it
  // as-is meant a search changed nothing past Core and OpenRouter: typing
  // "deepseek" left all 35 pages and the user paged to find it (reported
  // 2026-09-23). Filter the stable shuffle instead of re-shuffling.
  const shuffledTail = filterProviders(shuffledNonCompass, searchQuery).filter(
    (p) => p.id !== COMPASS_ID && (p.id !== OPENROUTER_ID || !openrouterVisible),
  );
  const tail = isSetUp
    ? [
        ...shuffledTail.filter((p) => isSetUp(p.id)),
        ...shuffledTail.filter((p) => !isSetUp(p.id)),
      ]
    : shuffledTail;

  if (compassVisible && openrouterVisible) {
    return [compass, openrouter, ...tail];
  }
  if (compassVisible) {
    return [compass, ...tail];
  }
  if (openrouterVisible) {
    return [openrouter, ...tail];
  }
  return shuffledNonCompass.length > 0 ? tail : filtered;
}

export function ProviderSettingsGrid() {
  const navigate = useNavigate();
  const [isDialogOpen, setIsDialogOpen] = useState(false);
  const [editingProvider, setEditingProvider] =
    useState<LanguageModelProvider | null>(null);
  const [providerToDelete, setProviderToDelete] = useState<string | null>(null);
  const [searchQuery, setSearchQuery] = useState("");
  const [page, setPage] = useState(1);
  const [shuffledNonCompass, setShuffledNonCompass] = useState<
    LanguageModelProvider[]
  >([]);

  const {
    data: providers,
    isLoading,
    error,
    isProviderSetup,
    refetch,
  } = useLanguageModelProviders();

  const { deleteProvider, isDeleting } = useCustomLanguageModelProvider();
  const keyChecks = useAtomValue(providerKeyCheckAtom);
  const { t } = useTranslation("settings");

  const filtered = useMemo(
    () => filterProviders(providers ?? [], searchQuery),
    [providers, searchQuery],
  );

  /*
   * Shuffled off `providers`, NOT off `filtered`.
   *
   * This used to depend on `filtered`, which changes identity on every
   * keystroke — so the grid reshuffled itself as you typed and the card you
   * were reaching for moved. The shuffle exists to stop the same handful of
   * providers always winning the first page; it has nothing to do with the
   * query, so the query must not retrigger it.
   */
  const reshuffleForDisplay = useCallback(() => {
    // OpenRouter is in the shuffle too: it is pinned only once set up.
    const rest = (providers ?? []).filter((p) => p.id !== COMPASS_ID);
    setShuffledNonCompass(shuffleArray(rest));
    setPage(1);
  }, [providers]);

  // Runs on mount now that the section is always open — it used to be gated on
  // the expand toggle, which was the only reason it did not.
  useEffect(() => {
    reshuffleForDisplay();
  }, [reshuffleForDisplay]);

  const orderedForPaging = useMemo(
    () =>
      orderProvidersForPaging(
        filtered,
        shuffledNonCompass,
        searchQuery,
        isProviderSetup,
      ),
    [filtered, searchQuery, shuffledNonCompass, isProviderSetup],
  );

  const totalPages = Math.max(
    1,
    Math.ceil(orderedForPaging.length / PAGE_SIZE),
  );
  const safePage = Math.min(page, totalPages);
  const pageSlice = orderedForPaging.slice(
    (safePage - 1) * PAGE_SIZE,
    safePage * PAGE_SIZE,
  );

  const configuredCount = useMemo(() => {
    if (!providers) return 0;
    return providers.filter((p) => isProviderSetup(p.id)).length;
  }, [providers, isProviderSetup]);

  const handleProviderClick = (providerId: string) => {
    navigate({
      to: `/integrations/providers/${providerId}`,
    });
  };

  const handleDeleteProvider = async () => {
    if (providerToDelete) {
      await deleteProvider(providerToDelete);
      setProviderToDelete(null);
      refetch();
    }
  };

  const handleEditProvider = (provider: LanguageModelProvider) => {
    setEditingProvider(provider);
    setIsDialogOpen(true);
  };

  if (isLoading) {
    return (
      <div className="rounded-lg border border-border overflow-hidden">
        <div className="px-4 py-3 bg-muted/40">
          <Skeleton className="h-5 w-48" />
        </div>
        <div className="p-6">
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
            {[1, 2, 3, 4, 5].map((i) => (
              <Card key={i} className="border-border">
                <CardHeader className="p-4">
                  <Skeleton className="h-6 w-3/4 mb-2" />
                  <Skeleton className="h-4 w-1/2" />
                </CardHeader>
              </Card>
            ))}
          </div>
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="rounded-lg border border-border overflow-hidden">
        <div className="px-4 py-3 bg-muted/40">
          <span className="text-sm font-medium">Model providers</span>
        </div>
        <div className="p-6">
          <Alert variant="destructive">
            <AlertTriangle className="h-4 w-4" />
            <AlertTitle>Error</AlertTitle>
            <AlertDescription>
              Failed to load AI providers: {error.message}
            </AlertDescription>
          </Alert>
        </div>
      </div>
    );
  }

  /*
   * NO COLLAPSIBLE WRAPPER, deliberately.
   *
   * This used to be a section that opened with a chevron, and it made sense when
   * "AI Settings" was one card among eleven on a single Settings scroll. It is
   * now the whole body of its own route — so the page header said
   * "Integrations", the card said "Models & providers", and this said "Model
   * providers": the same name three times, with a chevron in front of the only
   * content on the screen. A first-time user arriving to connect a model met a
   * closed box and no reason to think anything was behind it.
   *
   * The configured count survives as a line beside the search box, where it is
   * useful whether or not anything is expanded.
   */
  return (
    <div className="rounded-lg border border-border overflow-hidden bg-slate-900/20 dark:bg-slate-950/40">
      <div className="px-4 pb-4 pt-4 space-y-4">
        <div className="flex flex-wrap items-center gap-3">
          <Input
            placeholder="Search providers…"
            value={searchQuery}
            onChange={(e) => {
              setSearchQuery(e.target.value);
              setPage(1);
            }}
            className="max-w-md"
          />
          <span className="text-xs text-muted-foreground shrink-0">
            {configuredCount} provider{configuredCount === 1 ? "" : "s"}{" "}
            configured
          </span>
        </div>

          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
            {pageSlice.map((provider: LanguageModelProvider) => {
              const isCustom = provider.type === "custom";

              return (
                <Card
                  key={provider.id}
                  className="relative transition-all hover:shadow-md border-border cursor-pointer"
                  onClick={() => handleProviderClick(provider.id)}
                >
                  <CardHeader className="p-4">
                    {isCustom && (
                      <div
                        className="flex items-center justify-end"
                        onClick={(e) => e.stopPropagation()}
                      >
                        <Tooltip>
                          <TooltipTrigger asChild>
                            <Button
                              data-testid="edit-custom-provider"
                              aria-label={`Edit ${provider.name}`}
                              variant="ghost"
                              size="sm"
                              className="h-8 w-8 p-0 hover:bg-muted rounded-md"
                              onClick={() => handleEditProvider(provider)}
                            >
                              <Edit className="w-4 h-4" />
                            </Button>
                          </TooltipTrigger>
                          <TooltipContent>Edit Provider</TooltipContent>
                        </Tooltip>
                        <Tooltip>
                          <TooltipTrigger asChild>
                            <Button
                              data-testid="delete-custom-provider"
                              aria-label={`Delete ${provider.name}`}
                              variant="ghost"
                              size="sm"
                              className="h-8 w-8 p-0 text-destructive hover:text-destructive hover:bg-destructive/10 rounded-md"
                              onClick={() => setProviderToDelete(provider.id)}
                            >
                              <Trash2 className="w-4 h-4" />
                            </Button>
                          </TooltipTrigger>
                          <TooltipContent>Delete Provider</TooltipContent>
                        </Tooltip>
                      </div>
                    )}
                    <CardTitle className="text-lg font-medium mb-2">
                      {provider.name}
                      {keyChecks[provider.id] === "rejected" ? (
                        // Its page's check was refused: not "Ready" (QA #47).
                        <span className="ml-3 text-sm font-medium text-red-600 bg-red-50 dark:bg-red-900/30 border border-red-500/50 px-2 py-1 rounded-full">
                          {t("providers.keyRejected")}
                        </span>
                      ) : isProviderSetup(provider.id) ? (
                        <span className="ml-3 text-sm font-medium text-green-500 bg-green-50 dark:bg-green-900/30 border border-green-500/50 dark:border-green-500/50 px-2 py-1 rounded-full">
                          Ready
                        </span>
                      ) : (
                        <span className="text-sm text-gray-500 bg-gray-50 dark:bg-gray-900 dark:text-gray-300 px-2 py-1 rounded-full">
                          {/* An endpoint you added may need no key (a local
                              server): not "Add key" (QA #39), as the CLI says. */}
                          {isCustom ? "Your endpoint" : "Add key"}
                        </span>
                      )}
                    </CardTitle>
                    <CardDescription>
                      {provider.hasFreeTier && (
                        <span className="text-blue-600 mt-2 dark:text-blue-400 text-sm font-medium bg-blue-100 dark:bg-blue-900/30 px-2 py-1 rounded-full inline-flex items-center">
                          <GiftIcon className="w-4 h-4 mr-1" />
                          Free tier available
                        </span>
                      )}
                    </CardDescription>
                  </CardHeader>
                </Card>
              );
            })}
          </div>

          <button
            type="button"
            onClick={() => setIsDialogOpen(true)}
            className={cn(
              "flex flex-col items-center justify-center min-h-[100px] w-full rounded-lg border-2 border-dashed border-muted hover:border-muted-foreground transition cursor-pointer",
            )}
          >
            <PlusIcon className="h-6 w-6 mb-2 text-muted-foreground" />
            <span className="text-sm font-medium text-muted-foreground">
              Add custom provider
            </span>
            <span className="text-xs text-muted-foreground mt-1 px-2 text-center">
              API key + model name(s)
            </span>
          </button>

          {totalPages > 1 && (
            <div className="flex items-center justify-center gap-2 pt-2">
              <Button
                type="button"
                variant="outline"
                size="sm"
                disabled={safePage <= 1}
                onClick={() => setPage((p) => Math.max(1, p - 1))}
              >
                Previous
              </Button>
              <span className="text-xs text-muted-foreground tabular-nums">
                Page {safePage} of {totalPages}
              </span>
              <Button
                type="button"
                variant="outline"
                size="sm"
                disabled={safePage >= totalPages}
                onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
              >
                Next
              </Button>
            </div>
          )}
      </div>

      <CreateCustomProviderDialog
        isOpen={isDialogOpen}
        onClose={() => {
          setIsDialogOpen(false);
          setEditingProvider(null);
        }}
        onSuccess={() => {
          setIsDialogOpen(false);
          refetch();
          setEditingProvider(null);
        }}
        editingProvider={editingProvider}
      />

      <AlertDialog
        open={!!providerToDelete}
        onOpenChange={(open) => !open && setProviderToDelete(null)}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete Custom Provider</AlertDialogTitle>
            <AlertDialogDescription>
              This will permanently delete this custom provider and all its
              associated models. This action cannot be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={isDeleting}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={handleDeleteProvider}
              disabled={isDeleting}
            >
              {isDeleting ? "Deleting..." : "Delete Provider"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
