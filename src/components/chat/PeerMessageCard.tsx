import { useState } from "react";
import { useTranslation } from "react-i18next";
import { ChevronDown, ChevronRight, MessagesSquare } from "lucide-react";
import {
  peerSurfaceLabel,
  type PeerSegment,
} from "@/lib/peers/peer-message";
import { UserMessageMarkdownParser } from "./AtlarixMarkdownParser";

/**
 * A message from another Atlarix session (lib/peers): a teammate's, drawn like
 * a tool step on the agent's side of the conversation — never as the user's own
 * bubble, which read as something the user had typed. Long ones fold.
 *
 * A row can also hold the user's own words (queued messages are joined when an
 * idle chat wakes); those keep the user's bubble. No Edit on any of it: editing
 * rewrites the whole row, which would drop the teammate's message, and a
 * teammate's message is never the user's to resend (owner; the CLI's go-back
 * list skips it too, cli/agent/own-messages.ts).
 */
export function PeerMessageCard({ segments }: { segments: PeerSegment[] }) {
  return (
    <div className="flex flex-col gap-1.5">
      {segments.map((seg, i) =>
        seg.kind === "peer" ? (
          <div key={i} className="flex justify-start">
            <div className="mr-12 max-w-3xl">
              <PeerOne seg={seg} />
            </div>
          </div>
        ) : (
          <div key={i} className="flex justify-end">
            <div className="ml-12 max-w-3xl rounded-lg border border-user-bubble-border bg-user-bubble p-3 text-user-bubble-foreground">
              <UserMessageMarkdownParser content={seg.text} />
            </div>
          </div>
        ),
      )}
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
          {t("peerMessage.from")}{" "}
          <span className="font-medium text-foreground/90">
            {seg.from || t("peerMessage.anotherSession")}
          </span>{" "}
          {t("peerMessage.surface", { where })}
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
