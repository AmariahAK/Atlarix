/** Renderer stub — default shell detection runs in the main process only. */
export function detectDefaultShell(): string {
  return "/bin/sh";
}

const defaultShell = detectDefaultShell();
export default defaultShell;
