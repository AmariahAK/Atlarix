/**
 * Optional Monaco TextMate grammars (monaco-editor-textmate + fetched JSON).
 */

import * as monaco from "monaco-editor";
import { MONACO_LANGUAGE_MANIFEST } from "./language-manifest";

const grammarModules = import.meta.glob("./grammars/*.json", {
  eager: true,
  import: "default",
}) as Record<string, { scopeName?: string }>;

function grammarById(id: string): { scopeName?: string } | undefined {
  return grammarModules[`./grammars/${id}.json`];
}

let manifestRegistered = false;
let textMateReady = false;

/** Empty grammar for embedded scopes referenced by bundled grammars but not shipped. */
function stubGrammarDefinition(scopeName: string): object {
  return { scopeName, patterns: [] };
}

/** Scopes Monaco/TextMate may request that we do not bundle (avoid throw + Sentry noise). */
const PRECOMMON_STUB_SCOPES = [
  "source.lua",
  "source.sql",
  "source.css",
  "source.scss",
  "source.less",
  "source.ini",
  "text.xml",
  "source.xml",
  "source.shell",
  "source.batchfile",
  "source.graphql",
  "source.dart",
  "source.r",
] as const;

/** Register manifest aliases when Monaco has no built-in id */
export function registerManifestLanguages(): void {
  if (manifestRegistered) return;
  manifestRegistered = true;

  const registered = new Set(monaco.languages.getLanguages().map((l) => l.id));

  for (const entry of MONACO_LANGUAGE_MANIFEST) {
    if (registered.has(entry.monacoId)) continue;
    monaco.languages.register({ id: entry.monacoId });
    registered.add(entry.monacoId);
  }
}

export function isTextMateGrammarsReady(): boolean {
  return textMateReady;
}

export async function initTextMateGrammars(): Promise<boolean> {
  registerManifestLanguages();

  const scopeToGrammar = new Map<string, object>();
  for (const scope of PRECOMMON_STUB_SCOPES) {
    scopeToGrammar.set(scope, stubGrammarDefinition(scope));
  }
  const languages: { id: string; scope: string }[] = [];

  for (const entry of MONACO_LANGUAGE_MANIFEST) {
    const grammarId = entry.grammarId ?? entry.monacoId;
    const grammar = grammarById(grammarId);
    if (!grammar?.scopeName) continue;
    scopeToGrammar.set(grammar.scopeName, grammar);
    languages.push({ id: entry.monacoId, scope: grammar.scopeName });
  }

  if (languages.length === 0) {
    return false;
  }

  try {
    const [{ Registry }, { wireTmGrammars }, { loadWASM }] = await Promise.all([
      import("monaco-textmate"),
      import("monaco-editor-textmate"),
      import("onigasm"),
    ]);

    const onigWasmModule = await import("onigasm/lib/onigasm.wasm?url");
    const onigWasmUrl =
      typeof onigWasmModule === "string"
        ? onigWasmModule
        : (onigWasmModule as { default: string }).default;
    await loadWASM(onigWasmUrl);

    const registry = new Registry({
      getGrammarDefinition: async (scopeName) => {
        try {
          let content = scopeToGrammar.get(scopeName);
          if (!content) {
            content = stubGrammarDefinition(scopeName);
            scopeToGrammar.set(scopeName, content);
          }
          return { format: "json", content };
        } catch (err) {
          console.warn(`[monaco] grammar stub for ${scopeName}:`, err);
          return {
            format: "json",
            content: stubGrammarDefinition(scopeName),
          };
        }
      },
    });

    const grammarMap = new Map<string, string>();
    for (const lang of languages) {
      grammarMap.set(lang.id, lang.scope);
    }
    await wireTmGrammars(monaco, registry, grammarMap);
    textMateReady = true;
    return true;
  } catch (err) {
    console.warn(
      "[monaco] TextMate grammars unavailable — using Monaco built-ins. Run npm run fetch-monaco-grammars and optionally install monaco-editor-textmate monaco-textmate onigasm.",
      err,
    );
    return false;
  }
}

export { getMonacoLanguageForPath, getGrammarIdForPath } from "./language-manifest";
