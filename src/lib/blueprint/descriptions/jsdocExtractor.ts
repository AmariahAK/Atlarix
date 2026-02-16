/**
 * Extract first line of JSDoc or docstring for a symbol at a given line.
 * Used to populate simpleDescription without AI.
 */

export type DocLanguage = "ts" | "js" | "py";

/**
 * Get the first line of JSDoc (TS/JS) or docstring (Python) for the symbol at the given line.
 * @param content - Full file content
 * @param line - 1-based line number where the symbol (function/class) is declared
 * @param language - ts, js, or py
 * @returns First line of description or null
 */
export function getSimpleDescriptionFromDoc(
  content: string,
  line: number,
  language: DocLanguage
): string | null {
  const lines = content.split("\n");
  const idx = line - 1;
  if (idx < 0 || idx >= lines.length) return null;

  if (language === "py") {
    const decl = lines[idx];
    const tripleDouble = '"""';
    const tripleSingle = "'''";
    const nextLine = lines[idx + 1];
    if (nextLine?.includes(tripleDouble)) {
      const start = nextLine.indexOf(tripleDouble) + 3;
      const end = nextLine.indexOf(tripleDouble, start);
      if (end !== -1) {
        const doc = nextLine.slice(start, end).trim();
        return doc.split("\n")[0]?.trim() || null;
      }
      for (let i = idx + 2; i < lines.length; i++) {
        const endIdx = lines[i].indexOf(tripleDouble);
        if (endIdx !== -1) {
          const doc = lines
            .slice(idx + 1, i)
            .map((l) => l.trim())
            .join(" ")
            .replace(/^"""|"""$/g, "")
            .trim();
          return doc.split(/\s+/).slice(0, 15).join(" ") || null;
        }
      }
    }
    if (nextLine?.includes(tripleSingle)) {
      const start = nextLine.indexOf(tripleSingle) + 3;
      const end = nextLine.indexOf(tripleSingle, start);
      if (end !== -1) {
        const doc = nextLine.slice(start, end).trim();
        return doc.split("\n")[0]?.trim() || null;
      }
    }
    return null;
  }

  // TS/JS: find /** ... */ immediately above this line
  let comment = "";
  let i = idx - 1;
  while (i >= 0) {
    const trimmed = lines[i].trim();
    if (trimmed.startsWith("*") || trimmed.startsWith("*/")) {
      comment = trimmed + " " + comment;
      if (trimmed.startsWith("/**")) {
        const firstLine = comment
          .replace(/^\/\*\*?\s*/, "")
          .replace(/\*\/$/, "")
          .trim()
          .split("\n")[0]
          ?.replace(/^\s*\*\s?/, "")
          .trim();
        return firstLine || null;
      }
      i--;
      continue;
    }
    if (trimmed === "" || trimmed.startsWith("//")) {
      i--;
      continue;
    }
    break;
  }
  return null;
}
