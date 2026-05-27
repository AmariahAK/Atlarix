import { useState } from "react";
import { ExternalLink } from "lucide-react";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import type { SourceItem } from "@/atoms/sourceAtoms";
import { useCitationSources } from "./CitationSourcesContext";
import { citationLabelForSource } from "@/lib/chat/citation-sources";
import { useSetAtom } from "jotai";
import {
  aiPanelIntentAtom,
  selectedSourceAtom,
  sourceListAtom,
} from "@/atoms/sourceAtoms";
import { cn } from "@/lib/utils";

export function InlineWebCitation({ index }: { index: number }) {
  const sources = useCitationSources();
  const setSourceList = useSetAtom(sourceListAtom);
  const setSelectedSource = useSetAtom(selectedSourceAtom);
  const setPanelIntent = useSetAtom(aiPanelIntentAtom);
  const [open, setOpen] = useState(false);

  const source = sources[index - 1];
  if (!source) {
    return (
      <span className="inline-flex items-center px-1.5 py-0 rounded-md bg-muted/60 text-[10px] text-muted-foreground mx-0.5">
        [{index}]
      </span>
    );
  }

  const label = citationLabelForSource(source);

  const openInPanel = () => {
    setSourceList(sources);
    setSelectedSource(source);
    setPanelIntent({
      intent: "show-web-search",
      timestamp: Date.now(),
      source: "user",
    });
  };

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          className={cn(
            "inline-flex items-center gap-0.5 px-1.5 py-0 mx-0.5 rounded-md",
            "bg-muted/80 hover:bg-muted text-[10px] font-medium text-foreground/80",
            "align-baseline cursor-pointer border-0",
          )}
          onClick={(e) => {
            e.preventDefault();
            openInPanel();
          }}
          onMouseEnter={() => setOpen(true)}
        >
          {label}
          <ExternalLink className="h-2.5 w-2.5 opacity-60" />
        </button>
      </PopoverTrigger>
      <PopoverContent
        className="w-72 p-3"
        side="top"
        onMouseLeave={() => setOpen(false)}
      >
        <p className="text-sm font-medium text-foreground line-clamp-2 mb-2">
          {source.title}
        </p>
        <div className="flex items-center gap-2 text-xs text-muted-foreground">
          {source.favicon ? (
            <img
              src={source.favicon}
              alt=""
              className="h-4 w-4 rounded-sm"
              width={16}
              height={16}
            />
          ) : null}
          <span className="truncate">{citationLabelForSource(source)}</span>
        </div>
        <a
          href={source.url}
          target="_blank"
          rel="noopener noreferrer"
          className="mt-2 inline-flex items-center gap-1 text-[10px] text-primary hover:underline"
          onClick={(e) => e.stopPropagation()}
        >
          Open link
          <ExternalLink className="h-3 w-3" />
        </a>
      </PopoverContent>
    </Popover>
  );
}
