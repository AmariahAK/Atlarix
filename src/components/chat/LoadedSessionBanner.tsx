import { useAtom } from "jotai";
import {
  loadedSessionResumeAtom,
  loadedSessionTruncatedAtom,
} from "@/atoms/sessionAtoms";
import { SESSION_LOAD_MESSAGE_LIMIT } from "@/constants/session_constants";
import { X } from "lucide-react";

export function LoadedSessionBanner() {
  const [loadedResume, setLoadedResume] = useAtom(loadedSessionResumeAtom);
  const [truncated, setTruncated] = useAtom(loadedSessionTruncatedAtom);

  if (!loadedResume && !truncated) return null;

  const dismiss = () => {
    setLoadedResume(false);
    setTruncated(false);
  };

  return (
    <div className="mx-4 mb-2 px-3 py-2 rounded-md border border-border/60 bg-muted/40 text-xs text-muted-foreground flex items-start gap-2">
      <div className="flex-1 space-y-1">
        {loadedResume && (
          <p>
            Loaded previous session — the AI starts fresh but you can see your
            history above.
          </p>
        )}
        {truncated && (
          <p>
            Showing the most recent {SESSION_LOAD_MESSAGE_LIMIT / 2} exchanges
            from this session (older messages are stored but not loaded).
          </p>
        )}
      </div>
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
