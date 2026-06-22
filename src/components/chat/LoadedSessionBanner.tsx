import { useAtom } from "jotai";
import { loadedSessionTruncatedAtom } from "@/atoms/sessionAtoms";
import { X } from "lucide-react";

/** Dismissible notice when an older session was loaded with a truncated message window. */
export function LoadedSessionBanner() {
  const [truncated, setTruncated] = useAtom(loadedSessionTruncatedAtom);

  if (!truncated) return null;

  const dismiss = () => {
    setTruncated(false);
  };

  return (
    <div className="mx-4 mb-2 px-3 py-2 rounded-md border border-border/60 bg-muted/40 text-xs text-muted-foreground flex items-start gap-2">
      <p className="flex-1">
        Showing the most recent messages from this session (older messages are
        stored but not loaded).
      </p>
      <button
        type="button"
        className="shrink-0 text-muted-foreground hover:text-foreground"
        aria-label="Dismiss"
        onClick={dismiss}
      >
        <X className="h-3.5 w-3.5" />
      </button>
    </div>
  );
}
