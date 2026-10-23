/**
 * The composer's config menu: effort and voice input.
 *
 * NOT the model. The model is the chip beside this button
 * (`components/ModelPicker.tsx`) — it names what you are on, which this menu
 * could not do from behind an unlabelled sliders icon.
 *
 * Pass 7: Blueprint-in-prompt tier override removed with the Blueprint subsystem.
 * v12.7: MCP entry removed — MCP management lives in Settings → MCP Servers.
 * 15.7: the Verified MCP servers are back here, to connect or switch one (owner).
 * 15.7.1: they are the user's defaults now (the Verified five until changed).
 * 2026-09-21: model section removed — see the note at the menu body.
 * 15.11: computer use for the current model (same switch as Settings).
 */

import { useSettings } from "@/hooks/useSettings";
import { useCreditBalance } from "@/hooks/useCreditBalance";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import {
  COMPASS_PROVIDER_ID,
  isCoreAutoTier,
} from "@/ipc/shared/compass_constants";
import { useLanguageModelsByProviders } from "@/hooks/useLanguageModelsByProviders";
import { useTranscriptionProviders } from "@/hooks/useTranscriptionProviders";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { chosenLevel, effortSettingsPatch } from "@/lib/routing/model-reasoning-profile";
import { SlidersHorizontal, Brain, Mic, MousePointerClick } from "lucide-react";
import { computerUseKey, ineligibleReason } from "@/lib/computer/eligibility";
import { DefaultMcpMenuSection } from "@/components/DefaultMcpMenuSection";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";

/** What the menu holds; the icon button's name and its tooltip. */
const MENU_NAME = "Effort, voice & MCP servers";

export function ChatConfigDropdown() {
  const { settings, updateSettings } = useSettings();
  const { data: modelsByProviders } = useLanguageModelsByProviders();
  // /effort: the levels THIS model lists, exactly as listed (or paid Auto's
  // low / medium / max), RESOLVED IN MAIN and read off the model row. Calling the
  // capability lookups from the renderer looked equivalent and was not: the
  // models.dev reasoning registry and the Core tier→vendor routing map are both
  // main-process module state, so in here every lookup missed (the reason the
  // deep-thinking toggle once hid for the whole Atlarix Core lineup).
  //
  // Undefined (query still loading, or a model not in the list) hides the section
  // rather than guessing: a control that appears and then vanishes is worse than
  // one that arrives a moment late.
  const effortChoices =
    settings?.selectedModel != null
      ? modelsByProviders?.[settings.selectedModel.provider]?.find(
          (m) => m.apiName === settings.selectedModel.name,
        )?.effortChoices
      : undefined;
  const reasoningCapable = effortChoices != null;
  const selectedRow =
    settings?.selectedModel != null
      ? modelsByProviders?.[settings.selectedModel.provider]?.find(
          (m) => m.apiName === settings.selectedModel.name,
        )
      : undefined;
  const computerKey = settings?.selectedModel
    ? computerUseKey({ provider: settings.selectedModel.provider, name: settings.selectedModel.name })
    : null;
  const computerOn = settings?.computerUseModels ?? [];
  const computerWhy =
    selectedRow?.computerUse && selectedRow.computerUse !== "eligible" ? selectedRow.computerUse : null;
  const effortNow = effortChoices
    ? chosenLevel(effortChoices, settings?.effort, !!settings?.deepThinking && !settings?.effort)
    : undefined;
  const { t } = useTranslation("chat");
  const { t: tSettings } = useTranslation("settings");
  const onAuto =
    settings?.selectedModel?.provider === COMPASS_PROVIDER_ID &&
    isCoreAutoTier(settings.selectedModel.name);
  // Derived in main from (providers with a key) ∩ (providers with an
  // audio-input model), so the menu can't offer something that would fail at
  // transcription time.
  //
  // NO CURATED FALLBACK any more, and no always-present on-device entry. Both
  // existed because "voice must never present an empty picker" — which was true
  // while there was a free local engine to fall back to. Now an empty list is the
  // honest answer: there is no BYOK transcription, and the section hides. The mic
  // itself can still appear, off the selected model's own audio input
  // (`useVoiceCapability`), which needs nothing to pick.
  const { data: voiceProviders } = useTranscriptionProviders();
  const VOICE_PROVIDERS = voiceProviders ?? [];
  const [menuOpen, setMenuOpen] = useState(false);
  const { balanceCents } = useCreditBalance();
  // `"local"` is a setting for an engine that no longer exists — treat it as unset
  // rather than leaving a checkmark on a row that is not there.
  const stored = settings?.voiceTranscriptionProvider;
  const voiceProvider = stored && stored !== "local" ? stored : undefined;
  const effectiveVoiceProvider =
    VOICE_PROVIDERS.find((p) => p.id === voiceProvider)?.id ??
    VOICE_PROVIDERS[0]?.id;

  return (
    <DropdownMenu open={menuOpen} onOpenChange={setMenuOpen}>
      <Tooltip>
        <TooltipTrigger asChild>
          <DropdownMenuTrigger asChild>
            <Button
              variant="outline"
              size="sm"
              className="h-8 w-8 p-0"
              data-testid="chat-config-button"
              aria-label={MENU_NAME}
            >
              <SlidersHorizontal className="h-4 w-4" />
            </Button>
          </DropdownMenuTrigger>
        </TooltipTrigger>
        {/* NOT "Config: model" any more — the model left this menu. */}
        <TooltipContent>{MENU_NAME}</TooltipContent>
      </Tooltip>
      <DropdownMenuContent
        align="start"
        side="top"
        sideOffset={8}
        avoidCollisions
        collisionPadding={16}
        sticky="partial"
        className="z-200 w-72 max-h-(--radix-dropdown-menu-content-available-height) overflow-y-auto overflow-x-hidden p-0"
      >
        <div className="p-1">
          {/*
            NO MODEL SECTION HERE ANY MORE.
            ==============================
            This used to open with a "Model" label, the current model's name as
            text you could not click, and a "Change model" item. All three moved
            into the composer's model chip, which names the model on the surface
            instead of two clicks inside an unlabelled icon — the reason people
            added an API key and never realised their turns were still going to
            Atlarix Core.

            Leaving a second route here would have been the thing worth
            avoiding: two controls that both change the model, one of which
            shows you what it currently is.
          */}
          {reasoningCapable ? (
            <>
              <DropdownMenuLabel className="flex items-center gap-2 text-xs font-medium text-muted-foreground">
                <Brain className="h-3.5 w-3.5" />
                Effort
              </DropdownMenuLabel>
              {onAuto && balanceCents === 0 ? (
                // Free Auto runs at one level: the cost of being free (owner).
                <p className="px-2 pb-1 pt-0.5 text-[10px] leading-snug text-muted-foreground">
                  {t("atlarixAuto.effortFree")}
                </p>
              ) : (
                <>
                  <DropdownMenuRadioGroup
                    value={effortNow}
                    onValueChange={(v) => updateSettings(effortSettingsPatch(effortChoices!, v))}
                  >
                    {effortChoices!.levels.map((level) => (
                      <DropdownMenuRadioItem
                        key={level}
                        value={level}
                        onSelect={(e) => e.preventDefault()}
                        data-testid={`effort-${level}`}
                      >
                        {level}
                        {level === effortChoices!.defaultLevel ? (
                          <span className="ml-auto text-[10px] text-muted-foreground">default</span>
                        ) : null}
                      </DropdownMenuRadioItem>
                    ))}
                  </DropdownMenuRadioGroup>
                  <p className="px-2 pb-1 pt-0.5 text-[10px] leading-snug text-muted-foreground">
                    {onAuto ? t("atlarixAuto.effortHint") : "As this model lists them; higher thinks longer and costs more."}
                  </p>
                </>
              )}
            </>
          ) : null}
          {/* Only a separator when there is something above it to separate —
              the Reasoning block is conditional, and a rule at the very top of
              the menu reads as a rendering slip. */}
          {reasoningCapable && VOICE_PROVIDERS.length > 0 ? (
            <DropdownMenuSeparator />
          ) : null}
          {/* Nothing to choose between with no BYOK speech key — the whole
              section goes, rather than showing a label over an empty list. */}
          {VOICE_PROVIDERS.length > 0 ? (
            <>
              <DropdownMenuLabel className="flex items-center gap-2 text-xs font-medium text-muted-foreground">
                <Mic className="h-3.5 w-3.5" />
                Voice input
              </DropdownMenuLabel>
              {VOICE_PROVIDERS.map((p) => (
                <DropdownMenuCheckboxItem
                  key={p.id}
                  checked={effectiveVoiceProvider === p.id}
                  onCheckedChange={() =>
                    updateSettings({ voiceTranscriptionProvider: p.id })
                  }
                  onSelect={(e) => e.preventDefault()}
                >
                  {p.label}
                </DropdownMenuCheckboxItem>
              ))}
              <p className="px-2 pb-1 pt-0.5 text-[10px] leading-snug text-muted-foreground">
                Transcribed with your own provider key — never billed to Atlarix
                Core. Works on every model. Without one, the mic uses the
                selected model when it accepts audio.
              </p>
            </>
          ) : null}
          {/* The user's default MCP servers: connect or switch one without leaving the chat. */}
          {reasoningCapable || VOICE_PROVIDERS.length > 0 ? <DropdownMenuSeparator /> : null}
          {/* Computer use for THIS model: the same switch as Settings → Computer use. */}
          {selectedRow && computerKey ? (
            <>
              <DropdownMenuCheckboxItem
                checked={!computerWhy && computerOn.includes(computerKey)}
                disabled={computerWhy != null}
                onCheckedChange={(next) =>
                  updateSettings({
                    computerUseModels: next
                      ? [...computerOn.filter((k) => k !== computerKey), computerKey]
                      : computerOn.filter((k) => k !== computerKey),
                  })
                }
                onSelect={(e) => e.preventDefault()}
                data-testid="computer-use-toggle"
              >
                <MousePointerClick className="h-3.5 w-3.5" />
                {tSettings("computerUse.label")}
              </DropdownMenuCheckboxItem>
              {computerWhy ? (
                <p className="px-2 pb-1 pt-0.5 text-[10px] leading-snug text-muted-foreground">
                  {ineligibleReason(computerWhy)}
                </p>
              ) : null}
              <DropdownMenuSeparator />
            </>
          ) : null}
          <DefaultMcpMenuSection onLeave={() => setMenuOpen(false)} />
        </div>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
