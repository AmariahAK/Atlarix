/**
 * The composer's config menu: reasoning effort and voice input.
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
 */

import { useSettings } from "@/hooks/useSettings";
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
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { SlidersHorizontal, Brain, Mic } from "lucide-react";
import { DefaultMcpMenuSection } from "@/components/DefaultMcpMenuSection";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";

/** What the menu holds; the icon button's name and its tooltip. */
const MENU_NAME = "Reasoning, voice & MCP servers";

export function ChatConfigDropdown() {
  const { settings, updateSettings } = useSettings();
  const { data: modelsByProviders } = useLanguageModelsByProviders();
  // Only offer "deep thinking" for models that can actually reason (opencode's
  // capability gate) — otherwise the toggle would be a no-op.
  //
  // The answer is RESOLVED IN MAIN and read off the model row here. Calling the
  // capability gate directly from the renderer looked equivalent and was not: the
  // models.dev reasoning registry and the Core tier→vendor routing map are both
  // main-process module state, so in here every lookup missed and the gate fell
  // through to a provider allowlist containing no `compass` — hiding the toggle for
  // the entire Atlarix Core lineup while the same model on BYOK showed it.
  //
  // Undefined (query still loading, or a model not in the list) hides the row rather
  // than guessing: a toggle that appears and then vanishes is worse than one that
  // arrives a moment late, and a wrong guess offers a control that does nothing.
  const reasoningCapable =
    settings?.selectedModel != null &&
    modelsByProviders?.[settings.selectedModel.provider]?.find(
      (m) => m.apiName === settings.selectedModel.name,
    )?.supportsDeepThinking === true;
  const deepThinking = !!settings?.deepThinking;
  const { t } = useTranslation("chat");
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
  // `"local"` is a setting for an engine that no longer exists — treat it as unset
  // rather than leaving a checkmark on a row that is not there.
  const stored = settings?.voiceTranscriptionProvider;
  const voiceProvider = stored && stored !== "local" ? stored : undefined;
  const effectiveVoiceProvider =
    VOICE_PROVIDERS.find((p) => p.id === voiceProvider)?.id ??
    VOICE_PROVIDERS[0]?.id;

  return (
    <DropdownMenu>
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
                Reasoning
              </DropdownMenuLabel>
              <DropdownMenuCheckboxItem
                checked={deepThinking}
                onCheckedChange={(v) => updateSettings({ deepThinking: !!v })}
                onSelect={(e) => e.preventDefault()}
                data-testid="deep-thinking-toggle"
              >
                Deep thinking
                <span className="ml-auto text-[10px] text-muted-foreground">
                  {deepThinking ? "on" : "off"}
                </span>
              </DropdownMenuCheckboxItem>
              {onAuto ? (
                <p className="px-2 pb-1 pt-0.5 text-[10px] leading-snug text-muted-foreground">
                  {t("atlarixAuto.deepThinkingHint")}
                </p>
              ) : (
                <p className="px-2 pb-1 pt-0.5 text-[10px] leading-snug text-muted-foreground">
                  Off = high reasoning (default); on = the maximum this model
                  supports. Scales automatically to each model's capability.
                </p>
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
          <DefaultMcpMenuSection />
        </div>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
