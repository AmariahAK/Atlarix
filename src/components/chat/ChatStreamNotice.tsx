import { useEffect, useState } from "react";
import { Info } from "lucide-react";

const STORAGE_KEY = "atlarix.inlineActivityNotice.v1";

const NOTICE_TEXT =
  "Permissions and plans now appear inline in the chat. Open the right panel only when you view a plan or preview.";

/** One-time in-chat notice after inline activity UX rollout. */
export function ChatStreamNotice() {
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    try {
      if (localStorage.getItem(STORAGE_KEY) === "1") return;
      setVisible(true);
      localStorage.setItem(STORAGE_KEY, "1");
    } catch {
      setVisible(true);
    }
  }, []);

  if (!visible) return null;

  return (
    <div
      className="mx-4 mb-2 flex items-start gap-2 rounded-lg border border-border/50 bg-muted/30 px-3 py-2 text-xs text-muted-foreground"
      role="status"
    >
      <Info className="h-3.5 w-3.5 shrink-0 mt-0.5" aria-hidden />
      <p>{NOTICE_TEXT}</p>
      <button
        type="button"
        className="ml-auto shrink-0 text-[10px] uppercase tracking-wide hover:text-foreground"
        onClick={() => setVisible(false)}
      >
        Dismiss
      </button>
    </div>
  );
}
