/**
 * "You saved a key — do you want chats to actually use it?"
 *
 * THE GAP THIS CLOSES. `DEFAULT_SETTINGS.selectedModel` is Atlarix Core, and until
 * now *nothing in the app* ever read `providerSettings` and wrote `selectedModel`.
 * The only automatic re-route runs the other way — BYOK→Core, when a selected model
 * has no key (`get_model_client.ts`) — and it is explicitly guarded never to
 * re-route Core itself. So saving an API key changed which models were *available*
 * and nothing about which one ran: the next turn still went to Core and still spent
 * Core credit. The user had no way to know that short of noticing the balance fall.
 *
 * WHY AN OFFER AND NOT AN AUTOMATIC SWITCH. Changing the model is changing a setting
 * the user did not ask to change, and the right answer is genuinely ambiguous —
 * plenty of people add a key for one specific job and want Core for everything else.
 * So this asks, defaults to nothing, and disappears either way.
 *
 * THE CONDITION IS "ON CORE", NOT "FIRST KEY EVER". Someone adding a second provider
 * while still on Core has exactly the same problem as someone adding their first, and
 * "is this their first key" needs before/after state that this component would have
 * to thread through a save. `selectedModel.provider === "compass"` is the state that
 * actually hurts, and it is readable at any moment.
 */

import { useMemo } from "react";
import { useTranslation } from "react-i18next";
import { Check, X } from "lucide-react";

import { Button } from "@/components/ui/button";
import { useLanguageModelsByProviders } from "@/hooks/useLanguageModelsByProviders";
import { useSelectModel } from "@/hooks/useSelectModel";
import { showSuccess } from "@/lib/toast";
import type { LargeLanguageModel } from "@/lib/schemas";

export function UseProviderAsDefaultPrompt({
  providerId,
  providerName,
  onDismiss,
}: {
  providerId: string;
  providerName: string;
  onDismiss: () => void;
}) {
  const { t } = useTranslation("onboarding");
  const selectModel = useSelectModel();
  const { data: modelsByProviders } = useLanguageModelsByProviders();

  /*
   * The model this offer would select — and it is NAMED IN THE UI below, which is
   * the whole point.
   *
   * "First in the catalog" is an arbitrary rule. DeepSeek's list, for instance,
   * begins `deepseek-v4-flash-vision-exp` — so a silent "Use DeepSeek" could set a
   * user's default to an EXPERIMENTAL VISION model, and the first they would know
   * of it is odd answers or a surprising bill. There is no "recommended" flag in
   * the catalog to lean on, so rather than dress the guess up as a decision, the
   * offer states which model it means and lets the user disagree before clicking.
   *
   * Undefined while the list refetches after the key save, which is why the confirm
   * button is disabled rather than absent in that window.
   */
  const firstModel = useMemo(() => {
    const models = modelsByProviders?.[providerId];
    return models && models.length > 0 ? models[0] : undefined;
  }, [modelsByProviders, providerId]);

  const apply = async () => {
    if (!firstModel) return;
    const model: LargeLanguageModel = {
      provider: providerId as LargeLanguageModel["provider"],
      name: firstModel.apiName,
    };
    await selectModel(model);
    showSuccess(t("byokDefault.done", { model: firstModel.displayName }));
    onDismiss();
  };

  return (
    <div
      data-testid="use-provider-as-default-prompt"
      className="mt-3 rounded-md border border-primary/40 bg-primary/5 px-3 py-2.5"
    >
      <p className="text-sm font-medium text-foreground">
        {t("byokDefault.prompt", { provider: providerName })}
      </p>
      <p className="mt-0.5 text-xs text-muted-foreground">
        {t("byokDefault.detail")}
      </p>
      {firstModel ? (
        <p className="mt-1 text-xs text-muted-foreground">
          {t("byokDefault.willUse", { model: firstModel.displayName })}
        </p>
      ) : null}
      <div className="mt-2.5 flex flex-wrap gap-2">
        <Button
          type="button"
          size="sm"
          className="gap-1.5"
          disabled={!firstModel}
          onClick={() => void apply()}
        >
          <Check className="h-3.5 w-3.5" />
          {t("byokDefault.confirm", { provider: providerName })}
        </Button>
        <Button
          type="button"
          size="sm"
          variant="ghost"
          className="gap-1.5"
          onClick={onDismiss}
        >
          <X className="h-3.5 w-3.5" />
          {t("byokDefault.dismiss")}
        </Button>
      </div>
    </div>
  );
}
