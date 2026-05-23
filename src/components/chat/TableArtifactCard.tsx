import React from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { VisualArtifactCard } from "./VisualArtifactCard";

/** Renders a GFM markdown table inside artifact chrome. */
export function TableArtifactCard({ markdownTable }: { markdownTable: string }) {
  return (
    <VisualArtifactCard title="Table" layout="content">
      <div className="prose prose-sm dark:prose-invert max-w-none w-full">
        <ReactMarkdown remarkPlugins={[remarkGfm]}>{markdownTable}</ReactMarkdown>
      </div>
    </VisualArtifactCard>
  );
}
