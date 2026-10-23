/**
 * The Windows version resource of the compiled CLI (atlarix.exe).
 *
 * Without it the exe carries Bun's own: ProductName "Bun", CompanyName "Oven",
 * and that is what SmartScreen, Task Manager and a firewall prompt show (QA E6).
 * The publisher is the name the MSIX already shows (PublisherDisplayName).
 *
 * BUN ONLY WRITES THESE WHEN COMPILING ON WINDOWS. Cross-compiled from macOS or
 * Linux the build succeeds and the resource is still Bun's, so a QA exe built
 * off Windows proves nothing; the release builds the Windows CLI on
 * windows-latest, where it applies.
 */
import path from "node:path";

/** Four numbers, as a Windows FILEVERSION needs: "15.11.0-beta.2" → "15.11.0.2". */
export function windowsFileVersion(version: string): string {
  const nums = version.match(/\d+/g)?.map(Number) ?? [];
  return [0, 1, 2, 3].map((i) => String(nums[i] ?? 0)).join(".");
}

export function windowsExeMetadata(version: string, repoRoot: string) {
  return {
    title: "Atlarix",
    publisher: "Amariah Abishai",
    version: windowsFileVersion(version),
    description: "Atlarix CLI",
    icon: path.join(repoRoot, "assets", "icon", "logo.ico"),
  };
}
