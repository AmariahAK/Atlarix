import type { TerminalLine } from "@/atoms/terminalInstancesAtoms";

export type FormattableLine = Pick<TerminalLine, "prefix" | "text" | "kind">;

const KNOWN_TOOLS = new Set([
  "python",
  "python3",
  "python2",
  "node",
  "nodejs",
  "npm",
  "npx",
  "yarn",
  "pnpm",
  "bun",
  "deno",
  "git",
  "cargo",
  "go",
  "ruby",
  "php",
  "docker",
  "podman",
  "make",
  "cmake",
  "rustc",
  "javac",
  "java",
  "gradle",
  "mvn",
  "terraform",
  "ansible",
  "kubectl",
  "helm",
  "aws",
  "gcloud",
  "az",
  "pip",
  "pip3",
  "poetry",
  "uv",
  "rustc",
  "swift",
  "dotnet",
]);

/** Strip leading `$ ` from a prompt line body. */
export function commandFromPromptLine(text: string): string {
  return text.replace(/^\$\s*/, "").trim();
}

/** First prompt command in a line slice. */
export function commandFromLines(lines: FormattableLine[]): string | undefined {
  const prompt = lines.find((l) => l.kind === "prompt");
  if (!prompt) return undefined;
  return commandFromPromptLine(prompt.text);
}

function ownerLabel(prefix: TerminalLine["prefix"]): string {
  return prefix === "[Agent]" ? "Agent" : "You";
}

export function formatLineForDisplay(line: FormattableLine): string {
  if (line.kind === "prompt") {
    return `${line.prefix} ${line.text}`;
  }
  return line.text;
}

export function formatLineForCopy(line: FormattableLine): string {
  return formatLineForDisplay(line);
}

export function formatLineForModel(line: FormattableLine): string {
  if (line.kind === "prompt") {
    return `[${ownerLabel(line.prefix)}] ${line.text}`;
  }
  return line.text;
}

export function linesToVisibleText(lines: FormattableLine[]): string {
  return lines.map(formatLineForDisplay).join("\n");
}

export function linesToModelText(lines: FormattableLine[]): string {
  return lines.map(formatLineForModel).join("\n");
}

function tokenFromSegment(segment: string): string | undefined {
  const trimmed = segment.trim();
  if (!trimmed) return undefined;
  const first = trimmed.split(/\s+/)[0]?.toLowerCase();
  if (!first) return undefined;
  const base =
    first
      .replace(/^\.?\//, "")
      .split("/")
      .pop() ?? first;
  if (KNOWN_TOOLS.has(base)) return base;
  if (base === "py") return "python";
  return undefined;
}

/**
 * Label for terminal chips: derive from command (git, node, python), not always zsh.
 * For `cd foo && git status`, uses the last pipeline segment's tool.
 */
export function commandToolLabel(
  command: string | undefined,
  fallbackShell = "zsh",
): string {
  if (!command?.trim()) return fallbackShell;
  const segments = command.split(/\s*(?:&&|\|\||;)\s*/);
  for (let i = segments.length - 1; i >= 0; i--) {
    const tool = tokenFromSegment(segments[i] ?? "");
    if (tool) return tool;
  }
  const first = command.trim().split(/\s+/)[0]?.toLowerCase();
  if (first && KNOWN_TOOLS.has(first)) return first;
  if (
    first &&
    /^[a-z][a-z0-9._-]*$/i.test(first) &&
    first !== "cd" &&
    first !== "export" &&
    first !== "source"
  ) {
    return first;
  }
  return fallbackShell;
}
