import { useState } from "react";
import { useTranslation } from "react-i18next";
import { ChevronDown, ChevronRight, MessagesSquare } from "lucide-react";
import {
  peerSurfaceLabel,
  type PeerSegment,
} from "@/lib/peers/peer-message";
import { UserMessageMarkdownParser } from "./AtlarixMarkdownParser";

/**
 * A message from another Atlarix session (lib/peers), drawn like a tool step on
 * the agent's side of the conversation — never as the user's own bubble, which
 * read as something the user had typed. Long ones fold.
 */
export function PeerMessageCard({ segments }: { segments: PeerSegment[] }) {
  return (
    <div className="flex justify-start">
      <div className="mr-12 flex max-w-3xl flex-col gap-1.5">
        {segments.map((seg, i) =>
          seg.kind === "peer" ? (
            <PeerOne key={i} seg={seg} />
          ) : (
            <div key={i} className="text-sm text-muted-foreground">
              <UserMessageMarkdownParser content={seg.text} />
            </div>
          ),
        )}
      </div>
    </div>
  );
}

const FOLD_CHARS = 600;

function PeerOne({ seg }: { seg: Extract<PeerSegment, { kind: "peer" }> }) {
  const long = seg.text.length > FOLD_CHARS;
  const [open, setOpen] = useState(!long);
  const { t } = useTranslation("chat");
  const where = peerSurfaceLabel(seg.surface);
  return (
    <div className="rounded-md border border-border/70 bg-muted/40 text-sm">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="flex w-full items-center gap-1.5 px-3 py-2 text-left text-xs text-muted-foreground hover:text-foreground"
        aria-expanded={open}
      >
        {open ? (
          <ChevronDown className="h-3.5 w-3.5 shrink-0" aria-hidden />
        ) : (
          <ChevronRight className="h-3.5 w-3.5 shrink-0" aria-hidden />
        )}
        <MessagesSquare className="h-3.5 w-3.5 shrink-0" aria-hidden />
        <span>
          {t("peerMessage.from", { where })}{" "}
          <span className="font-medium text-foreground/90">
            {seg.from || t("peerMessage.anotherSession")}
          </span>
        </span>
      </button>
      {open ? (
        <div className="border-t border-border/60 px-3 py-2 text-foreground/90">
          <UserMessageMarkdownParser content={seg.text} />
        </div>
      ) : null}
    </div>
  );
}
