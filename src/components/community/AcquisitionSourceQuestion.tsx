/**
 * "Where did you hear about Atlarix?" — asked at most once per account, and
 * permanently available in Settings → Community.
 *
 * One component for both surfaces so the option list, the write path and the
 * answered state can't diverge between them.
 */
import { useState } from "react";
import { Check, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import { IpcClient } from "@/ipc/ipc_client";
import { useAuth } from "@/lib/auth/useAuth";
import {
  ACQUISITION_SOURCES,
  ACQUISITION_DETAIL_MAX,
  OTHER_SOURCE_ID,
  acquisitionLabel,
} from "@/lib/community/acquisition";

export function AcquisitionSourceQuestion({
  answeredSource,
  onAnswered,
  compact = false,
}: {
  /** Existing answer, if any — the question becomes a read-only summary. */
  answeredSource?: { source: string; detail?: string } | null;
  onAnswered?: () => void;
  compact?: boolean;
}) {
  const [selected, setSelected] = useState<string | null>(null);
  const [detail, setDetail] = useState("");
  const [saving, setSaving] = useState(false);
  const { user } = useAuth();

  if (answeredSource?.source) {
    return (
      <p className="text-sm text-muted-foreground flex items-center gap-2">
        <Check className="h-4 w-4 text-emerald-500 shrink-0" aria-hidden />
        Thanks — you told us you found Atlarix via{" "}
        <span className="text-foreground font-medium">
          {answeredSource.detail
            ? `${acquisitionLabel(answeredSource.source)} (${answeredSource.detail})`
            : acquisitionLabel(answeredSource.source)}
        </span>
        .
      </p>
    );
  }

  const needsDetail = selected === OTHER_SOURCE_ID;
  const canSubmit =
    !!selected && (!needsDetail || detail.trim().length > 0) && !saving;

  const submit = async () => {
    if (!selected || saving) return;
    setSaving(true);
    try {
      await IpcClient.getInstance().recordAcquisitionSource(
        selected,
        needsDetail ? detail.trim() : undefined,
        user?.id,
      );
      onAnswered?.();
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap gap-2">
        {ACQUISITION_SOURCES.map((option) => (
          <button
            key={option.id}
            type="button"
            onClick={() => setSelected(option.id)}
            className={cn(
              "rounded-full border px-3 py-1.5 text-sm transition-colors",
              selected === option.id
                ? "border-emerald-500 bg-emerald-500/10 text-foreground"
                : "border-border text-muted-foreground hover:bg-muted/50",
            )}
          >
            {option.label}
          </button>
        ))}
      </div>

      {needsDetail ? (
        <Input
          autoFocus
          value={detail}
          maxLength={ACQUISITION_DETAIL_MAX}
          onChange={(e) => setDetail(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && canSubmit) void submit();
          }}
          placeholder="Where, specifically?"
          className={compact ? "h-8 text-sm" : undefined}
        />
      ) : null}

      <Button
        size={compact ? "sm" : "default"}
        disabled={!canSubmit}
        onClick={() => void submit()}
      >
        {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
        Send
      </Button>
    </div>
  );
}
