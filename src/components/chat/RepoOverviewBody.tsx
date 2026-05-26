import { useState } from "react";
import { cn } from "@/lib/utils";

type Section = { title: string; lines: string[] };

function parseOverviewSections(markdown: string): {
  title?: string;
  sections: Section[];
} {
  const lines = markdown.split("\n");
  let title: string | undefined;
  const sections: Section[] = [];
  let current: Section | null = null;

  for (const line of lines) {
    if (line.startsWith("# ") && !line.startsWith("## ")) {
      title = line.replace(/^#\s+/, "").trim();
      continue;
    }
    if (line.startsWith("## ")) {
      if (current && current.lines.length > 0) sections.push(current);
      current = { title: line.replace(/^##\s+/, "").trim(), lines: [] };
      continue;
    }
    if (current) current.lines.push(line);
  }
  if (current && current.lines.length > 0) sections.push(current);

  if (sections.length === 0 && markdown.trim()) {
    sections.push({ title: "Output", lines: lines });
  }
  return { title, sections };
}

function isTreeSection(title: string): boolean {
  return /structure|top-level|files/i.test(title);
}

export function RepoOverviewBody({ markdown }: { markdown: string }) {
  const { title, sections } = parseOverviewSections(markdown);
  const [readmeOpen, setReadmeOpen] = useState(false);

  return (
    <div className="space-y-2 text-[11px]">
      {title ? (
        <div className="font-medium text-foreground/90">{title}</div>
      ) : null}
      {sections.map((section) => {
        const tree = isTreeSection(section.title);
        const body = section.lines.join("\n").trim();
        if (!body) return null;

        if (tree) {
          return (
            <div key={section.title}>
              <div className="text-[10px] uppercase tracking-wide text-muted-foreground mb-1">
                {section.title}
              </div>
              <pre
                className={cn(
                  "rounded-md border border-border/30 bg-background/50 p-2",
                  "font-mono text-[10px] leading-snug whitespace-pre-wrap break-words",
                  "max-h-48 overflow-auto overscroll-contain",
                )}
              >
                {body}
              </pre>
            </div>
          );
        }

        if (/readme/i.test(section.title) && body.length > 400) {
          return (
            <div key={section.title}>
              <button
                type="button"
                className="text-[10px] text-primary hover:underline"
                onClick={() => setReadmeOpen((o) => !o)}
              >
                {readmeOpen ? "Hide" : "Show"} {section.title}
              </button>
              {readmeOpen ? (
                <pre className="mt-1 max-h-40 overflow-auto rounded-md border border-border/30 bg-background/50 p-2 font-mono text-[10px] whitespace-pre-wrap">
                  {body}
                </pre>
              ) : null}
            </div>
          );
        }

        return (
          <div key={section.title}>
            <div className="text-[10px] uppercase tracking-wide text-muted-foreground mb-0.5">
              {section.title}
            </div>
            <pre className="font-mono text-[10px] text-muted-foreground whitespace-pre-wrap break-words max-h-32 overflow-auto">
              {body.length > 800 ? `${body.slice(0, 800)}…` : body}
            </pre>
          </div>
        );
      })}
    </div>
  );
}
