/**
 * The first thing the compiled CLI does (imported first by entry.mts, before
 * anything heavy loads): for an interactive start, put the terminal in raw mode
 * so keys typed while the rest loads are not echoed over the screen. They wait
 * in stdin and the UI reads them once it starts. Batch runs and pipes untouched.
 */
const args = process.argv.slice(2);
const batch =
  ["run", "login", "logout"].includes(args[0] ?? "") ||
  args.some((a) => ["--prompt", "--prompt-file", "--version", "-v", "--help", "-h"].includes(a));
if (!batch && process.stdin.isTTY && process.stdout.isTTY) {
  try {
    process.stdin.setRawMode(true);
  } catch {
    /* not a real terminal after all */
  }
}
