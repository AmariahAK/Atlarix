import { useState } from "react";
import { cn } from "@/lib/utils";
import { toolBodyMaxH, toolBodyText } from "../stream-item-styles";
import { CopyButton } from "./ToolCardActions";

const LONG_LINE_THRESHOLD = 18;
const LONG_CHAR_THRESHOLD = 1200;

/**
 * Consistent scrollable `<pre>` body for tool results: shared max-height + font
 * tokens, a hover copy button, and a "Show full" toggle for long output.
 */
export function ToolScrollableBody({
  text,
  mono = true,
  copy = true,
  isError = false,
  className,
}: {
  text: string;
  mono?: boolean;
  copy?: boolean;
  isError?: boolean;
  className?: string;
}) {
  const [full, setFull] = useState(false);
  const isLong =
    text.split(/\r?\n/).length > LONG_LINE_THRESHOLD ||
    text.length > LONG_CHAR_THRESHOLD;

  return (
    <div className="relative group">
      {copy && !isError ? (
        <CopyButton
          text={text}
          className="absolute right-0 top-0 opacity-0 group-hover:opacity-100 focus:opacity-100 bg-muted/60"
        />
      ) : null}
      <pre
        className={cn(
          toolBodyText,
          "whitespace-pre-wrap break-words",
          mono ? "font-mono" : "font-sans",
          isError
            ? "text-destructive"
            : "text-foreground/85 dark:text-muted-foreground",
          full ? "overflow-auto" : cn(toolBodyMaxH, "overflow-auto"),
          className,
        )}
      >
        {text}
      </pre>
      {isLong ? (
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            setFull((f) => !f);
          }}
          className="mt-1 text-[10px] font-medium text-muted-foreground hover:text-foreground"
        >
          {full ? "Show less" : "Show full"}
        </button>
      ) : null}
    </div>
  );
}
