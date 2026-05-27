import { useEffect, useState } from "react";
import { ChevronDown, ChevronRight } from "lucide-react";
import {
  thoughtBlockBody,
  thoughtBlockButton,
  thoughtBlockMeta,
  thoughtBlockShell,
  streamToolCardChevron,
} from "./stream-item-styles";

export function InlineThoughtBlock({
  content,
  isStreaming,
  keepOpenAfterStream = false,
}: {
  content: string;
  isStreaming: boolean;
  /** When true (e.g. inside sub-agent cards), do not auto-collapse after stream ends. */
  keepOpenAfterStream?: boolean;
}) {
  const [open, setOpen] = useState(isStreaming || keepOpenAfterStream);

  useEffect(() => {
    if (!isStreaming && !keepOpenAfterStream) setOpen(false);
  }, [isStreaming, keepOpenAfterStream]);

  if (!content.trim()) return null;

  const lineCount = content.split("\n").length;

  return (
    <div className={thoughtBlockShell}>
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className={thoughtBlockButton}
      >
        {open ? (
          <ChevronDown className={streamToolCardChevron} />
        ) : (
          <ChevronRight className={streamToolCardChevron} />
        )}
        <span className="font-medium">
          Thoughts
          {!open ? (
            <span className={thoughtBlockMeta}>
              {" "}
              · {lineCount} {lineCount === 1 ? "line" : "lines"}
            </span>
          ) : null}
        </span>
      </button>
      {open ? <div className={thoughtBlockBody}>{content}</div> : null}
    </div>
  );
}
