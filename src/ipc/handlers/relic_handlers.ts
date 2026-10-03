/**
 * Relics in the app (the Relics tab, and RelicCard's preview). The logic is
 * shared with the CLI's /relics (src/lib/relics/relic-store.ts). A local relic
 * is read or deleted only as an index.html inside a `.atlarix/relics/` folder
 * of a workspace Atlarix knows — never an arbitrary path the renderer names.
 */
import fs from "node:fs";
import { ipcMain } from "electron";
import { db } from "@/db";
import { apps } from "@/db/schema";
import {
  isLocalRelicPath,
  listRelics,
  removeRelic,
  setRelicVisibility,
  type RelicSummary,
  type RelicVisibility,
} from "@/lib/relics/relic-store";

export { isLocalRelicPath };

const MAX_PREVIEW_BYTES = 5 * 1024 * 1024;

function knownWorkspaces(): string[] {
  return db.select({ path: apps.path }).from(apps).all().map((a) => a.path);
}

export function registerRelicHandlers(): void {
  ipcMain.handle("relics:read-local", async (_event, file: string): Promise<{ html: string } | { error: string }> => {
    if (typeof file !== "string" || !file) return { error: "No file." };
    if (!isLocalRelicPath(file, knownWorkspaces())) return { error: "Not a relic." };
    try {
      if (fs.statSync(file).size > MAX_PREVIEW_BYTES) return { error: "Too large to preview." };
      return { html: fs.readFileSync(file, "utf8") };
    } catch {
      return { error: "The relic file is gone." };
    }
  });

  ipcMain.handle("relics:list", async (_event, workspacePath: string): Promise<RelicSummary[]> => {
    // Local relics only for a workspace Atlarix knows; hosted ones regardless.
    const known = typeof workspacePath === "string" && knownWorkspaces().includes(workspacePath);
    return listRelics(known ? workspacePath : "/nonexistent-atlarix-workspace");
  });

  ipcMain.handle("relics:delete", async (_event, relic: Pick<RelicSummary, "id" | "hosted" | "path">): Promise<void> => {
    if (!relic || typeof relic.id !== "string") throw new Error("No relic.");
    await removeRelic(relic, knownWorkspaces());
  });

  ipcMain.handle("relics:set-visibility", async (_event, id: string, visibility: RelicVisibility): Promise<void> => {
    if (typeof id !== "string" || (visibility !== "private" && visibility !== "link")) throw new Error("Bad request.");
    await setRelicVisibility(id, visibility);
  });
}
