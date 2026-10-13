import { createContext } from "react";
import type { ToolExpandView } from "@/lib/chat/tool-expand-view";

/**
 * A message's write cards as its finished thread holds them: the whole old/new
 * file, merged from the approval or write preview, keyed by tool call id. The
 * stored tool parts (older steps) carry only the model's own args — an edit's
 * snippets — so drawn alone they diffed those, numbered from 1 (QA #6).
 */
export const ThreadDiffByCallIdContext = createContext<
  ReadonlyMap<string, ToolExpandView>
>(new Map());
