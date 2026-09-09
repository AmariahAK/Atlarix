/**
 * Full-screen loading UI shown until the main process has initialized the database.
 * Refactor: ThoughtsPanel — use Compass animation (no logo).
 */
import AtlarixAnimation from "@/components/atlarix/AtlarixAnimation";

export function AppLoadingScreen() {
  return <AtlarixAnimation size="full" phase="thinking" />;
}
