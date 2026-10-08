/**
 * Atlarix Auto's live readout beside the context line. Auto hides model names —
 * it picks one per step — so this says only how the step was paid for: the free
 * share left today, or "Included" (Pro) / "Credits" (pay-as-you-go). Shown only
 * while Auto is selected; before the first reply it follows the account.
 *
 * The nudge appears once a free share runs low — the one moment an upgrade
 * prompt is useful rather than an ad. Once it is spent and the slower free
 * model answers, the label says that instead of "0%".
 */
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { IpcClient } from "@/ipc/ipc_client";
import type { AutoStatus } from "@/main/auto-status";
import { useAccountKind } from "@/hooks/useAccountKind";
import { UPGRADE_LINE } from "@/shared/billing_copy";

/** Below this percentage of today's share, suggest upgrading. */
export const AUTO_LOW_SHARE_PERCENT = 20;

export function AtlarixAutoStatus() {
  const { t } = useTranslation("chat");
  const account = useAccountKind();
  const [status, setStatus] = useState<AutoStatus | null>(null);
  useEffect(() => IpcClient.getInstance().onAutoStatus(setStatus), []);

  const paid =
    status?.billing === "paid" ||
    (status?.billing == null && (account === "pro" || account === "payg"));
  const freeRemaining = paid ? null : (status?.freeRemaining ?? null);
  // The share is spent and the slower $0 model is answering: say so, rather
  // than "0%" while replies quietly get worse.
  const onFloor = !paid && status?.onFloor === true;
  const low =
    !onFloor && freeRemaining != null && freeRemaining < AUTO_LOW_SHARE_PERCENT;
  if (!status && account === "unknown") return null;

  const label = paid
    ? account === "pro"
      ? t("atlarixAuto.statusIncluded")
      : t("atlarixAuto.statusCredits")
    : onFloor
      ? t("atlarixAuto.statusFloor")
      : freeRemaining != null
      ? t("atlarixAuto.statusFree", { percent: freeRemaining })
      : t("atlarixAuto.statusFreePlain");

  return (
    <span
      data-testid="atlarix-auto-status"
      className={
        onFloor
          ? "shrink-0 text-[10px] tabular-nums text-amber-600 dark:text-amber-400"
          : "shrink-0 text-[10px] tabular-nums text-muted-foreground/90"
      }
      title={
        onFloor
          ? t("atlarixAuto.floorTitle")
          : low
          ? UPGRADE_LINE
          : paid
            ? `${t("atlarixAuto.statusTitle")} ${t("atlarixAuto.privateTitle")}`
            : t("atlarixAuto.statusTitle")
      }
    >
      {label}
      {paid && (
        <span className="ml-1 text-primary">· {t("atlarixAuto.privateShort")}</span>
      )}
      {low && (
        <span className="ml-1 text-amber-600 dark:text-amber-400">
          · {t("atlarixAuto.lowShare")}
        </span>
      )}
    </span>
  );
}
