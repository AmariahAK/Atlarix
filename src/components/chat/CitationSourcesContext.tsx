import { createContext, useContext } from "react";
import type { SourceItem } from "@/atoms/sourceAtoms";

export const CitationSourcesContext = createContext<SourceItem[]>([]);

export function useCitationSources(): SourceItem[] {
  return useContext(CitationSourcesContext);
}
