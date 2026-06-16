import { db } from "../../db";
import { apps } from "../../db/schema";
import { eq } from "drizzle-orm";
import type {
  Version,
  BranchResult,
  RevertVersionParams,
  RevertVersionResponse,
} from "../ipc_types";
import type { GitCommit } from "../git_types";
import fs from "node:fs";
import path from "node:path";
import { getAtlarixAppPath } from "../../paths/paths";
import { withLock } from "../utils/lock_utils";
import log from "electron-log";
import { createLoggedHandler } from "./safe_handle";

import {
  gitCheckout,
  gitCommit,
  gitStageToRevert,
  gitCurrentBranch,
  gitLog,
} from "../utils/git_utils";

const logger = log.scope("version_handlers");

const handle = createLoggedHandler(logger);

export function registerVersionHandlers() {
  handle("list-versions", async (_, { appId }: { appId: number }) => {
    const app = await db.query.apps.findFirst({
      where: eq(apps.id, appId),
    });

    if (!app) {
      // The app might have just been deleted, so we return an empty array.
      return [];
    }

    const appPath = getAtlarixAppPath(app.path);

    const { findGitRepositoryRoot } = await import("../utils/git_utils");
    if (!findGitRepositoryRoot(appPath)) {
      return [];
    }

    let commits: GitCommit[];
    try {
      commits = await gitLog({
        path: appPath,
        depth: 100_000, // KEEP UP TO DATE WITH ChatHeader.tsx
      });
    } catch (err: unknown) {
      // Empty repo / no HEAD / not fully initialized — return [] so UI doesn't throw
      const msg = err instanceof Error ? err.message : String(err);
      const name = (err as { name?: string })?.name ?? "";
      const isNoHead =
        msg.includes("Could not find HEAD") ||
        msg.includes("NotFoundError") ||
        msg.includes("ref not found") ||
        msg.includes("bad default revision") ||
        name === "NotFoundError";
      if (isNoHead) {
        return [];
      }
      throw err;
    }

    return commits.map((commit: GitCommit) => {
      return {
        oid: commit.oid,
        message: commit.commit.message,
        timestamp: commit.commit.author.timestamp,
      };
    }) satisfies Version[];
  });

  handle(
    "get-current-branch",
    async (_, { appId }: { appId: number }): Promise<BranchResult> => {
      const app = await db.query.apps.findFirst({
        where: eq(apps.id, appId),
      });

      if (!app) {
        throw new Error("App not found");
      }

      const appPath = getAtlarixAppPath(app.path);

      // Git is optional - if not initialized, version features unavailable
      if (!fs.existsSync(path.join(appPath, ".git"))) {
        throw new Error("Git repository not initialized - version features unavailable");
      }

      try {
        const currentBranch = await gitCurrentBranch({ path: appPath });

        return {
          branch: currentBranch || "<no-branch>",
        };
      } catch (error: any) {
        logger.error(`Error getting current branch for app ${appId}:`, error);
        throw new Error(`Failed to get current branch: ${error.message}`);
      }
    },
  );

  handle(
    "revert-version",
    async (
      _,
      { appId, previousVersionId }: RevertVersionParams,
    ): Promise<RevertVersionResponse> => {
      return withLock(appId, async () => {
        const successMessage = "Restored version";
        const warningMessage = "";
        const app = await db.query.apps.findFirst({
          where: eq(apps.id, appId),
        });

        if (!app) {
          throw new Error("App not found");
        }

        const appPath = getAtlarixAppPath(app.path);

        await gitCheckout({
          path: appPath,
          ref: "main",
        });

        await gitStageToRevert({
          path: appPath,
          targetOid: previousVersionId,
        });

        await gitCommit({
          path: appPath,
          message: `Reverted all changes back to version ${previousVersionId}`,
        });

        // Legacy DB message truncation removed with workspace-only chats.

        if (warningMessage) {
          return { warningMessage };
        }
        return { successMessage };
      });
    },
  );

  handle(
    "checkout-version",
    async (
      _,
      { appId, versionId: gitRef }: { appId: number; versionId: string },
    ): Promise<void> => {
      return withLock(appId, async () => {
        const app = await db.query.apps.findFirst({
          where: eq(apps.id, appId),
        });

        if (!app) {
          throw new Error("App not found");
        }

        const fullAppPath = getAtlarixAppPath(app.path);
        await gitCheckout({
          path: fullAppPath,
          ref: gitRef,
        });
      });
    },
  );
}
