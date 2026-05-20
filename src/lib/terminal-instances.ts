import type {
  TerminalInstance,
  TerminalLine,
} from "@/atoms/terminalInstancesAtoms";

export function defaultUserInstanceLabel(instances: TerminalInstance[]): string {
  const n =
    instances.filter((i) => i.owner === "user").length + 1;
  return `Shell ${n}`;
}

export function defaultAgentInstanceLabel(
  command: string,
  instances: TerminalInstance[],
): string {
  const n =
    instances.filter((i) => i.owner === "agent").length + 1;
  const short = command.trim().slice(0, 28);
  return short ? `Agent ${n}: ${short}` : `Agent ${n}`;
}

export function outputToLines(
  prefix: "[Agent]" | "[You]",
  command: string,
  output: string,
  status: "running" | "completed" | "error",
): TerminalLine[] {
  const lines: TerminalLine[] = [
    {
      id: `cmd-${Date.now()}-${Math.random()}`,
      prefix,
      text: `$ ${command}`,
      kind: "prompt",
    },
  ];
  if (output.trim()) {
    lines.push({
      id: `out-${Date.now()}-${Math.random()}`,
      prefix,
      text: output,
      kind: "output",
    });
  }
  if (status === "completed" || status === "error") {
    lines.push({
      id: `st-${Date.now()}-${Math.random()}`,
      prefix,
      text: status === "completed" ? "exit 0" : "failed",
      kind: "status",
    });
  }
  return lines;
}
