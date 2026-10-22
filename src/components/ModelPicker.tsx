/**
 * The model chip — the composer's one control for "which model am I on?".
 *
 * WHAT IT REPLACED, AND WHY.
 * The model used to be reachable three ways and visible none: an unlabelled
 * sliders icon whose menu held the name as inert text plus a "Change model"
 * item, Cmd/Ctrl+J opening a right-edge Sheet, and this component — which only
 * rendered when the right panel happened to be open. Nothing anywhere put the
 * model's NAME on screen. That is why people saved a BYOK key, saw their
 * models appear in a list, and went on spending Atlarix Core credit without a
 * single cue that anything was still pointed at Core; the app grew a persisted
 * one-time coachmark (`useByokModelHint`) to announce a fact the UI could have
 * simply shown.
 *
 * So: the name is the button, it is always present, and it is the only route.
 * The config menu beside it kept reasoning and voice and gave up the model
 * entirely.
 *
 * WHY THIS FILE AND NOT `ModelPickerSheetContent`. The Sheet grouped models in
 * accordions that stayed COLLAPSED while you typed, so a search could match a
 * model you could not see. It also dropped `customModelId` when selecting a
 * custom model, writing an identity the rest of the app cannot resolve. This
 * component already had the flat search, the Core/Ollama/LM Studio label
 * resolution and the correct select payload; it inherited the Sheet's one real
 * advantage, the price badge.
 */

import { useAtomValue } from "jotai";
import { peerModelByChatIdAtom } from "@/atoms/chatAtoms";
import { useCallback, useEffect, useMemo, useState } from "react";
import { useSettings } from "@/hooks/useSettings";
import { useSelectModel } from "@/hooks/useSelectModel";
import { useLanguageModelsByProviders } from "@/hooks/useLanguageModelsByProviders";
import { useLanguageModelProviders } from "@/hooks/useLanguageModelProviders";
import { useAtlarixCoreCatalog } from "@/hooks/useAtlarixCoreCatalog";
import { useLocalModels } from "@/hooks/useLocalModels";
import { useLocalLMSModels } from "@/hooks/useLMStudioModels";
import { useModelDisplayName } from "@/hooks/useModelDisplayName";
import { useModelPickerOpen } from "@/hooks/useModelPickerOpen";

import { Input } from "@/components/ui/input";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { PriceBadge } from "@/components/PriceBadge";
import { ChevronDown, Cpu, Search } from "lucide-react";
import { cn } from "@/lib/utils";
import type { LargeLanguageModel } from "@/lib/schemas";
import type { LanguageModel } from "@/ipc/ipc_types";
import { resolveModelDisplayLabel } from "@/lib/resolve-model-display-label";
import { AtlarixAutoConsentDialog } from "@/components/AtlarixAutoConsentDialog";
import {
  ATLARIX_AUTO_CONSENT_VERSION,
  autoConsentAccepted,
  isCoreAutoTier,
} from "@/ipc/shared/compass_constants";
import { fetchAccountKind, useAccountKind } from "@/hooks/useAccountKind";
import { useTranslation } from "react-i18next";
import { UpgradeActions } from "@/components/billing/UpgradeActions";

const COMPASS_ID = "compass";
/** Rows rendered per provider before the list offers search instead. */
const PER_GROUP_CAP = 6;
/** Rows rendered for a query. The catalog is models.dev-wide — hundreds of rows. */
const SEARCH_CAP = 50;

type Option = {
  providerId: string;
  providerName: string;
  model: LanguageModel;
  primary: string;
  secondary: string;
};

/** Split `model (provider)` labels from resolveModelDisplayLabel; otherwise use provider column. */
function optionLabelLines(
  resolved: string,
  fallbackProviderName: string,
): { primary: string; secondary: string } {
  const match = resolved.match(/^(.+?)\s+\(([^)]+)\)\s*$/);
  if (match) {
    return { primary: match[1]!.trim(), secondary: match[2]!.trim() };
  }
  return { primary: resolved, secondary: fallbackProviderName };
}

export function ModelPicker({
  className,
  resetKey,
  onOpened,
}: {
  className?: string;
  /** Usually the thread id — changing it closes the picker. */
  resetKey?: number | null;
  /** Fired when the picker opens, for the coachmark/tour to stand down. */
  onOpened?: () => void;
}) {
  const { settings, updateSettings } = useSettings();
  const selectModel = useSelectModel();
  // Atlarix Auto waiting on its one-time consent (see AtlarixAutoConsentDialog).
  const [pendingAuto, setPendingAuto] = useState<LargeLanguageModel | null>(
    null,
  );
  const { open, setOpen } = useModelPickerOpen(resetKey);
  const [searchQuery, setSearchQuery] = useState("");
  const account = useAccountKind();
  const { t } = useTranslation("chat");
  // A free account picked a pinned Core model: show the upgrade line in place.
  const [lockedPick, setLockedPick] = useState(false);
  const { data: modelsByProviders, isLoading } = useLanguageModelsByProviders();
  const { data: providers } = useLanguageModelProviders();
  const { data: catalog = [] } = useAtlarixCoreCatalog();
  const { models: ollamaModels = [] } = useLocalModels();
  const { models: lmStudioModels = [] } = useLocalLMSModels();
  const modelDisplayName = useModelDisplayName();

  // A model another session set for this chat (item 9) is what it runs on.
  const peerModel = useAtomValue(peerModelByChatIdAtom).get(resetKey ?? -1);
  const selectedModel =
    peerModel && settings?.selectedModel
      ? { ...settings.selectedModel, provider: peerModel.provider, name: peerModel.name }
      : settings?.selectedModel;

  // A yes given to the OLD wording ("shared with OpenAI") is asked again ONCE,
  // when free Auto is in use: it now also runs on free models through other
  // providers. Recorded as asked the moment it opens, so it never repeats; a
  // "Not now" keeps the OpenAI-only Auto that yes covered.
  const [reaskAuto, setReaskAuto] = useState(false);
  useEffect(() => {
    if (!settings || reaskAuto || account !== "free") return;
    const onAuto =
      selectedModel?.provider === COMPASS_ID &&
      isCoreAutoTier(selectedModel.name);
    const oldYes =
      !!settings.atlarixAutoConsentAt &&
      (settings.atlarixAutoConsentVersion ?? 1) < ATLARIX_AUTO_CONSENT_VERSION;
    if (!onAuto || !oldYes || settings.atlarixAutoConsentV2AskedAt) return;
    setReaskAuto(true);
    void updateSettings({
      atlarixAutoConsentV2AskedAt: new Date().toISOString(),
    });
  }, [settings, selectedModel, account, reaskAuto, updateSettings]);

  const getProviderName = useCallback(
    (providerId: string) =>
      providers?.find((p) => p.id === providerId)?.name ?? providerId,
    [providers],
  );

  const resolveOptionLabel = useCallback(
    (providerId: string, model: LanguageModel) => {
      const providerName = getProviderName(providerId);
      const resolved = resolveModelDisplayLabel(
        {
          provider: providerId as LargeLanguageModel["provider"],
          name: model.apiName,
          customModelId: model.type === "custom" ? model.id : undefined,
        },
        {
          catalog,
          modelsByProviders: modelsByProviders ?? undefined,
          providerName,
          ollamaDisplayName: ollamaModels.find(
            (m) => m.modelName === model.apiName,
          )?.displayName,
          lmStudioDisplayName: lmStudioModels.find(
            (m) => m.modelName === model.apiName,
          )?.displayName,
        },
      );
      return optionLabelLines(resolved, providerName);
    },
    [catalog, modelsByProviders, ollamaModels, lmStudioModels, getProviderName],
  );

  /** Every configured provider that has models, Atlarix Core first. */
  const groups = useMemo(() => {
    if (!modelsByProviders)
      return [] as { id: string; name: string; options: Option[] }[];
    const entries = Object.entries(modelsByProviders).filter(
      ([, models]) => (models?.length ?? 0) > 0,
    );
    entries.sort(([a], [b]) =>
      a === COMPASS_ID ? -1 : b === COMPASS_ID ? 1 : 0,
    );
    return entries.map(([providerId, models]) => ({
      id: providerId,
      name: getProviderName(providerId),
      options: (models ?? []).map((model) => {
        const { primary, secondary } = resolveOptionLabel(providerId, model);
        return {
          providerId,
          providerName: getProviderName(providerId),
          model,
          primary,
          secondary,
        };
      }),
    }));
  }, [modelsByProviders, getProviderName, resolveOptionLabel]);

  const hasAnyProvider = groups.length > 0;

  /**
   * Matches across every provider, flat and ranked by nothing but order.
   *
   * `total` is computed BEFORE the cap so the footer can say how much is being
   * withheld. The old code discarded it, which is how a 50-row slice could look
   * like the whole catalog.
   */
  const { matches, total } = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    if (!q) return { matches: [] as Option[], total: 0 };
    const list: Option[] = [];
    for (const group of groups) {
      for (const option of group.options) {
        const { model, primary, secondary } = option;
        const hit =
          group.id.toLowerCase().includes(q) ||
          group.name.toLowerCase().includes(q) ||
          primary.toLowerCase().includes(q) ||
          secondary.toLowerCase().includes(q) ||
          (model.displayName?.toLowerCase().includes(q) ?? false) ||
          (model.apiName?.toLowerCase().includes(q) ?? false);
        if (hit) list.push(option);
      }
    }
    return { matches: list.slice(0, SEARCH_CAP), total: list.length };
  }, [groups, searchQuery]);

  const onSelect = (model: LargeLanguageModel) => {
    const isCore = model.provider === COMPASS_ID;
    const isAuto = isCore && isCoreAutoTier(model.name);
    // Pinned Core models are paid: a free account gets the two ways to pay
    // instead of a selection that 402s on the first message.
    if (isCore && !isAuto && account === "free") {
      setLockedPick(true);
      return;
    }
    setOpen(false);
    setSearchQuery("");
    setLockedPick(false);
    // Only FREE Auto shares prompts, so only an account with nothing to pay
    // with is asked. A paying account's Auto is billed and never shared.
    if (
      isAuto &&
      (!settings?.atlarixAutoConsentAt ||
        (settings.atlarixAutoConsentVersion ?? 1) < ATLARIX_AUTO_CONSENT_VERSION)
    ) {
      // Unknown here can be a balance still loading on a paying account: ask
      // main before asking the user (QA #42). Still unknown (signed out,
      // offline) asks, as before.
      void (async () => {
        const kind = account === "unknown" ? await fetchAccountKind() : account;
        if (kind === "free" || kind === "unknown") setPendingAuto(model);
        else void selectModel(model);
      })();
      return;
    }
    void selectModel(model);
  };

  const acceptAuto = async () => {
    const model = pendingAuto;
    setPendingAuto(null);
    if (!model) return;
    await updateSettings(autoConsentAccepted());
    void selectModel(model);
  };

  // Atlarix Auto's row says, in plain words, what happens to the prompts:
  // paid Auto (Pro or credit) is private and never trains anything; free Auto
  // is shared with the providers that serve it. Unknown account: no claim.
  const autoPrivacyLine = (o: Option): string | null => {
    if (o.providerId !== COMPASS_ID || !isCoreAutoTier(o.model.apiName)) return null;
    if (account === "pro" || account === "payg") return t("atlarixAuto.rowPrivate");
    if (account === "free") return t("atlarixAuto.rowFree");
    return null;
  };

  const isSelected = (o: Option) =>
    selectedModel?.provider === o.providerId &&
    selectedModel?.name === o.model.apiName;

  const row = (o: Option) => (
    <button
      key={`${o.providerId}:${o.model.apiName}`}
      type="button"
      onClick={() =>
        onSelect({
          provider: o.providerId as LargeLanguageModel["provider"],
          name: o.model.apiName,
          ...(o.model.type === "custom" ? { customModelId: o.model.id } : {}),
        })
      }
      className={cn(
        // NOT `accent` / `secondary`: both are AMBER in both themes, and this
        // row's text is green (muted-foreground, the price badge) or white —
        // unreadable on amber (reported by a user 2026-09-23). A neutral hover
        // and a primary-tinted selection keep every line legible.
        "flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-sm transition-colors hover:bg-muted",
        isSelected(o) && "bg-primary/15 ring-1 ring-inset ring-primary/30",
      )}
    >
      <span className="min-w-0 flex-1">
        <span className="block truncate font-medium">{o.primary}</span>
        <span className="block truncate text-xs text-muted-foreground">
          {autoPrivacyLine(o) ?? o.secondary}
        </span>
      </span>
      <PriceBadge
        cost={"cost" in o.model ? o.model.cost : undefined}
        core={
          o.providerId !== COMPASS_ID
            ? undefined
            : isCoreAutoTier(o.model.apiName)
              ? "auto"
              : "pinned"
        }
        account={account}
      />
    </button>
  );

  if (!settings) return null;

  const label = modelDisplayName;

  return (
    <>
      <AtlarixAutoConsentDialog
        open={pendingAuto != null || reaskAuto}
        onAccept={() => {
          if (pendingAuto) return void acceptAuto();
          setReaskAuto(false);
          void updateSettings(autoConsentAccepted());
        }}
        onCancel={() => {
          setPendingAuto(null);
          setReaskAuto(false);
        }}
      />
      <Popover
        open={open}
        onOpenChange={(next) => {
          setOpen(next);
          if (!next) setLockedPick(false);
          if (next) onOpened?.();
        }}
      >
        <PopoverTrigger asChild>
          <button
            type="button"
            data-testid="model-picker-trigger"
            title={label}
            className={cn(
              // Matches ChatIntentSelector next to it, which is the control this
              // sits beside all day; the old trigger was a size larger.
              "inline-flex h-7 min-w-[5.5rem] items-center gap-1 rounded-md border border-border bg-background px-2 text-xs font-medium",
              "hover:bg-muted/50 focus:bg-muted/50 focus:outline-none focus-visible:ring-2 focus-visible:ring-ring",
              className,
            )}
          >
            <Cpu className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
            <span className="max-w-[180px] truncate">{label}</span>
            <ChevronDown className="h-3.5 w-3.5 shrink-0 opacity-50" />
          </button>
        </PopoverTrigger>
        <PopoverContent
          align="start"
          side="top"
          sideOffset={8}
          avoidCollisions
          collisionPadding={16}
          className="z-200 w-[320px] max-h-[min(70vh,var(--radix-popover-content-available-height,70vh))] overflow-hidden p-0"
          /*
           * Focus is taken HERE rather than with `autoFocus` on the Input. Two
           * composers can be mounted at once (see useModelPickerOpen), and an
           * `autoFocus` fires for whichever mounted last regardless of which
           * popover the user actually opened — so the caret landed in a search
           * box on the other side of the window.
           */
          onOpenAutoFocus={(e) => {
            e.preventDefault();
            const content =
              e.currentTarget instanceof HTMLElement ? e.currentTarget : null;
            content?.querySelector("input")?.focus();
          }}
        >
          <div className="border-b border-border p-2">
            <div className="relative">
              <Search className="absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
              <Input
                placeholder="Search models…"
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                className="h-8 pl-8 text-sm"
              />
            </div>
          </div>

          {lockedPick && (
            <div
              data-testid="model-picker-locked"
              className="border-b border-border bg-muted/40 p-3"
            >
              <UpgradeActions />
            </div>
          )}
          <div className="max-h-[300px] overflow-y-auto p-1">
            {isLoading ? (
              <p className="py-3 text-center text-xs text-muted-foreground">
                Loading…
              </p>
            ) : !hasAnyProvider ? (
              /*
               * THE DEAD END THIS PICKER EXISTS TO AVOID.
               * The old copy here read "Type to search providers and models",
               * which is advice that cannot work when the reason the list is
               * empty is that nothing is connected. Ported from the Sheet, which
               * got this right.
               */
              <div className="space-y-1 px-2 py-3 text-center">
                <p className="text-xs font-medium">No providers configured</p>
                <p className="text-xs text-muted-foreground">
                  Add a key in Integrations → Models &amp; providers, or use
                  Atlarix Auto, which needs no key and is free to start.
                </p>
              </div>
            ) : searchQuery.trim() ? (
              matches.length === 0 ? (
                <p className="py-3 text-center text-xs text-muted-foreground">
                  No matches. Try claude, gpt, gemini…
                </p>
              ) : (
                <>
                  <div className="space-y-0.5">{matches.map(row)}</div>
                  {total > matches.length && (
                    <p className="px-2 pb-1 pt-2 text-center text-[10px] text-muted-foreground">
                      Showing {matches.length} of {total} — refine your search.
                    </p>
                  )}
                </>
              )
            ) : (
              /*
               * NO QUERY: grouped, capped per provider.
               *
               * A flat `slice(0, 50)` over the whole catalog was fine while this
               * was a secondary control, and became a trap the moment it was the
               * ONLY route: with OpenRouter configured the catalog runs to
               * hundreds of rows, so the first fifty could be fifty OpenRouter
               * models with Atlarix Core and your local models never on screen.
               */
              groups.map((group) => {
                const shown = group.options.slice(0, PER_GROUP_CAP);
                const hidden = group.options.length - shown.length;
                return (
                  <div key={group.id} className="pb-1">
                    <div className="sticky top-0 z-10 bg-popover px-2 py-1 text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
                      {group.name}
                    </div>
                    <div className="space-y-0.5">{shown.map(row)}</div>
                    {hidden > 0 && (
                      <p className="px-2 pt-1 text-[10px] text-muted-foreground">
                        +{hidden} more — search to see{" "}
                        {hidden === 1 ? "it" : "them"}.
                      </p>
                    )}
                  </div>
                );
              })
            )}
          </div>
        </PopoverContent>
      </Popover>
    </>
  );
}
