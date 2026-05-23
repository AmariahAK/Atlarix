import React, { useState, useEffect, memo, type ReactNode } from "react";
import ShikiHighlighter, {
  isInlineCode,
  createHighlighterCore,
  createJavaScriptRegexEngine,
} from "react-shiki/core";
import type { Element as HastElement } from "hast";
import { useTheme } from "../../contexts/ThemeContext";
import { Copy, Check } from "lucide-react";
import { MermaidRenderer } from "@/components/MermaidRenderer";
import { MarkmapRenderer } from "@/components/chat/MarkmapRenderer";
import { ChartArtifactCard } from "@/components/chat/ChartArtifactCard";
import { VisualArtifactCard } from "@/components/chat/VisualArtifactCard";
import { inferArtifactTitle } from "@/lib/visual-artifacts/infer-title";
import github from "@shikijs/themes/github-light-default";
import githubDark from "@shikijs/themes/github-dark-default";
import astro from "@shikijs/langs/astro";
import css from "@shikijs/langs/css";
import graphql from "@shikijs/langs/graphql";
import html from "@shikijs/langs/html";
import java from "@shikijs/langs/java";
import javascript from "@shikijs/langs/javascript";
import json from "@shikijs/langs/json";
import jsx from "@shikijs/langs/jsx";
import less from "@shikijs/langs/less";
import markdown from "@shikijs/langs/markdown";
import python from "@shikijs/langs/python";
import sass from "@shikijs/langs/sass";
import scss from "@shikijs/langs/scss";
import shell from "@shikijs/langs/shell";
import sql from "@shikijs/langs/sql";
import tsx from "@shikijs/langs/tsx";
import typescript from "@shikijs/langs/typescript";
import vue from "@shikijs/langs/vue";

type HighlighterCore = Awaited<ReturnType<typeof createHighlighterCore>>;

let highlighterPromise: Promise<HighlighterCore> | null = null;

function getHighlighter(): Promise<HighlighterCore> {
  if (!highlighterPromise) {
    highlighterPromise = createHighlighterCore({
      themes: [github, githubDark],
      langs: [
        astro,
        css,
        graphql,
        html,
        java,
        javascript,
        json,
        jsx,
        less,
        markdown,
        python,
        sass,
        scss,
        shell,
        sql,
        tsx,
        typescript,
        vue,
      ],
      engine: createJavaScriptRegexEngine(),
    });
  }
  return highlighterPromise as Promise<HighlighterCore>;
}

function useHighlighter() {
  const [highlighter, setHighlighter] = useState<HighlighterCore>();

  useEffect(() => {
    getHighlighter().then(setHighlighter);
  }, []);

  return highlighter;
}

interface CodeHighlightProps {
  className?: string | undefined;
  children?: ReactNode | undefined;
  node?: HastElement | undefined;
}

export const CodeHighlight = memo(
  ({ className, children, node, ...props }: CodeHighlightProps) => {
    const code = String(children).trim();
    const language = className?.match(/language-(\w+)/)?.[1];
    const isInline = node ? isInlineCode(node) : false;
    const [copied, setCopied] = useState(false);
    const handleCopy = () => {
      navigator.clipboard.writeText(code);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    };

    const { isDarkMode } = useTheme();
    const highlighter = useHighlighter();

    if (!isInline && (language === "chart" || language === "json-chart")) {
      return (
        <div className="not-prose my-2 w-full">
          <ChartArtifactCard code={code} />
        </div>
      );
    }

    if (!isInline && language === "mermaid") {
      const title = inferArtifactTitle("mermaid", code) ?? "Diagram";
      return (
        <div className="not-prose my-2 w-full">
          <VisualArtifactCard title={title} layout="canvas">
            <MermaidRenderer code={code} embedded className="h-full min-h-0" />
          </VisualArtifactCard>
        </div>
      );
    }

    if (!isInline && language === "markmap") {
      const title = inferArtifactTitle("markmap", code) ?? "Mind map";
      return (
        <div className="not-prose my-2 w-full">
          <VisualArtifactCard title={title} layout="canvas">
            <MarkmapRenderer content={code} embedded className="h-full min-h-0" />
          </VisualArtifactCard>
        </div>
      );
    }

    return !isInline ? (
      <div
        className="shiki not-prose relative [&_pre]:overflow-auto 
      [&_pre]:rounded-lg [&_pre]:px-6 [&_pre]:py-7"
      >
        <div className="absolute top-2 left-2 right-2 text-xs flex justify-between items-center z-10">
          {language ? (
            <span className="tracking-tighter text-muted-foreground/85">
              {language}
            </span>
          ) : (
            <span className="tracking-tighter text-muted-foreground/50">
              code
            </span>
          )}
          {code && (
            <button
              className="flex items-center gap-1 px-2 py-1 text-xs cursor-pointer 
                hover:bg-muted/80 rounded transition-colors
                text-muted-foreground hover:text-foreground"
              onClick={handleCopy}
              type="button"
              title="Copy code"
            >
              {copied ? <Check size={14} /> : <Copy size={14} />}
              <span>{copied ? "Copied!" : "Copy"}</span>
            </button>
          )}
        </div>
        {highlighter ? (
          <ShikiHighlighter
            highlighter={highlighter}
            language={language}
            theme={isDarkMode ? "github-dark-default" : "github-light-default"}
            delay={150}
          >
            {code}
          </ShikiHighlighter>
        ) : (
          <pre>
            <code>{code}</code>
          </pre>
        )}
      </div>
    ) : (
      <code className={className} {...props}>
        {children}
      </code>
    );
  },
  (prevProps, nextProps) => {
    return prevProps.children === nextProps.children;
  },
);
