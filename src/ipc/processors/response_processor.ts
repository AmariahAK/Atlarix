import { db } from "../../db";
import { apps } from "../../db/schema";
import {
  getStreamTransport,
  getStreamTransportAppId,
} from "@/lib/chat/stream-transport";
import { eq } from "drizzle-orm";
import fs from "node:fs";
import { getAtlarixAppPath } from "../../paths/paths";
import path from "node:path";
import { safeJoin } from "../utils/path_utils";

import log from "electron-log";
import {
  gitCommit,
  gitAdd,
  gitRemove,
  gitAddAll,
  getGitUncommittedFiles,
} from "../utils/git_utils";
import { isFsAccessDenied } from "../utils/fs-access-errors";
import {
  getAtlarixWriteTags,
  getAtlarixRenameTags,
  getAtlarixDeleteTags,
} from "../utils/atlarix_tag_parser";

import { FileUploadsState } from "../utils/file_uploads_state";

const readFile = fs.promises.readFile;
const logger = log.scope("response_processor");

interface Output {
  message: string;
  error: unknown;
}

export async function processFullResponseActions(
  fullResponse: string,
  chatId: number,
  {
    chatSummary,
    messageId,
  }: {
    chatSummary: string | undefined;
    messageId: number;
  },
): Promise<{
  updatedFiles?: boolean;
  error?: string;
  extraFiles?: string[];
  extraFilesError?: string;
}> {
  const fileUploadsState = FileUploadsState.getInstance();
  const fileUploadsMap = fileUploadsState.getFileUploadsForChat(chatId);
  fileUploadsState.clear(chatId);
  logger.log("processFullResponseActions for chatId", chatId);
  const appId = getStreamTransportAppId(chatId);
  const app = appId
    ? await db.query.apps.findFirst({ where: eq(apps.id, appId) })
    : null;
  if (!app) {
    logger.error(`No app found for chat transport ID: ${chatId}`);
    return {};
  }

  const appPath = getAtlarixAppPath(app.path);
  const writtenFiles: string[] = [];
  const renamedFiles: string[] = [];
  const deletedFiles: string[] = [];
  let hasChanges = false;

  const warnings: Output[] = [];
  const errors: Output[] = [];
  const ephemeralChat = getStreamTransport(chatId);

  try {
    // Extract all tags
    const atlarixWriteTags = getAtlarixWriteTags(fullResponse);
    const atlarixRenameTags = getAtlarixRenameTags(fullResponse);
    const atlarixDeletePaths = getAtlarixDeleteTags(fullResponse);

    const message = ephemeralChat?.messages.find(
      (m) => m.id === messageId && m.role === "assistant",
    );

    if (!message) {
      logger.error(`No ephemeral message found for ID: ${messageId}`);
      return {};
    }

    //////////////////////
    // File operations //
    // Do it in this order:
    // 1. Deletes
    // 2. Renames
    // 3. Writes
    //
    // Why?
    // - Deleting first avoids path conflicts before the other operations.
    // - LLMs like to rename and then edit the same file.
    //////////////////////

    // Process all file deletions
    for (const filePath of atlarixDeletePaths) {
      const fullFilePath = safeJoin(appPath, filePath);

      // Delete the file if it exists
      if (fs.existsSync(fullFilePath)) {
        let isDirectory = false;
        try {
          isDirectory = fs.lstatSync(fullFilePath).isDirectory();
        } catch (statErr) {
          if (isFsAccessDenied(statErr)) {
            logger.warn(
              `[FS] Permission denied — skipping delete for ${fullFilePath}`,
            );
            continue;
          }
          throw statErr;
        }
        if (isDirectory) {
          fs.rmSync(fullFilePath, { recursive: true, force: true });
        } else {
          fs.unlinkSync(fullFilePath);
        }
        logger.log(`Successfully deleted file: ${fullFilePath}`);
        deletedFiles.push(filePath);

        // Remove the file from git
        try {
          await gitRemove({ path: appPath, filepath: filePath });
        } catch (error) {
          logger.warn(`Failed to git remove deleted file ${filePath}:`, error);
          // Continue even if remove fails as the file was still deleted
        }
      } else {
        logger.warn(`File to delete does not exist: ${fullFilePath}`);
      }
    }

    // Process all file renames
    for (const tag of atlarixRenameTags) {
      const fromPath = safeJoin(appPath, tag.from);
      const toPath = safeJoin(appPath, tag.to);

      // Ensure target directory exists
      const dirPath = path.dirname(toPath);
      fs.mkdirSync(dirPath, { recursive: true });

      // Rename the file
      if (fs.existsSync(fromPath)) {
        fs.renameSync(fromPath, toPath);
        logger.log(`Successfully renamed file: ${fromPath} -> ${toPath}`);
        renamedFiles.push(tag.to);

        // Add the new file and remove the old one from git
        await gitAdd({ path: appPath, filepath: tag.to });
        try {
          await gitRemove({ path: appPath, filepath: tag.from });
        } catch (error) {
          logger.warn(`Failed to git remove old file ${tag.from}:`, error);
          // Continue even if remove fails as the file was still renamed
        }
      } else {
        logger.warn(`Source file for rename does not exist: ${fromPath}`);
      }
      // Only handle individual functions, not shared modules
    }

    // Process all file writes
    for (const tag of atlarixWriteTags) {
      const filePath = tag.path;
      let content: string | Buffer = tag.content;
      const fullFilePath = safeJoin(appPath, filePath);

      // Check if content (stripped of whitespace) exactly matches a file ID and replace with actual file content
      if (fileUploadsMap) {
        const trimmedContent = tag.content.trim();
        const fileInfo = fileUploadsMap.get(trimmedContent);
        if (fileInfo) {
          try {
            const fileContent = await readFile(fileInfo.filePath);
            content = fileContent;
            logger.log(
              `Replaced file ID ${trimmedContent} with content from ${fileInfo.originalName}`,
            );
          } catch (error) {
            logger.error(
              `Failed to read uploaded file ${fileInfo.originalName}:`,
              error,
            );
            errors.push({
              message: `Failed to read uploaded file: ${fileInfo.originalName}`,
              error: error,
            });
          }
        }
      }

      // Ensure directory exists
      const dirPath = path.dirname(fullFilePath);
      fs.mkdirSync(dirPath, { recursive: true });

      // Write file content
      fs.writeFileSync(fullFilePath, content);
      logger.log(`Successfully wrote file: ${fullFilePath}`);
      writtenFiles.push(filePath);
    }

    // If we have any file changes, commit them all at once
    hasChanges =
      writtenFiles.length > 0 ||
      renamedFiles.length > 0 ||
      deletedFiles.length > 0;

    let uncommittedFiles: string[] = [];
    let extraFilesError: string | undefined;

    if (hasChanges) {
      // Stage all written files
      for (const file of writtenFiles) {
        await gitAdd({ path: appPath, filepath: file });
      }

      // Create commit with details of all changes
      const changes = [];
      if (writtenFiles.length > 0)
        changes.push(`wrote ${writtenFiles.length} file(s)`);
      if (renamedFiles.length > 0)
        changes.push(`renamed ${renamedFiles.length} file(s)`);
      if (deletedFiles.length > 0)
        changes.push(`deleted ${deletedFiles.length} file(s)`);

      let message = chatSummary
        ? `[atlarix] ${chatSummary} - ${changes.join(", ")}`
        : `[atlarix] ${changes.join(", ")}`;
      // Use chat summary, if provided, or default for commit message
      let commitHash = await gitCommit({
        path: appPath,
        message,
      });
      logger.log(`Successfully committed changes: ${changes.join(", ")}`);

      // Check for any uncommitted changes after the commit
      uncommittedFiles = await getGitUncommittedFiles({ path: appPath });

      if (uncommittedFiles.length > 0) {
        // Stage all changes
        await gitAddAll({ path: appPath });
        try {
          commitHash = await gitCommit({
            path: appPath,
            message: message + " + extra files edited outside of Atlarix",
            amend: true,
          });
          logger.log(
            `Amend commit with changes outside of Atlarix: ${uncommittedFiles.join(", ")}`,
          );
        } catch (error) {
          // Just log, but don't throw an error because the user can still
          // commit these changes outside of Atlarix if needed.
          logger.error(
            `Failed to commit changes outside of Atlarix: ${uncommittedFiles.join(
              ", ",
            )}`,
          );
          extraFilesError = (error as any).toString();
        }
      }

      if (commitHash) {
        (message as unknown as { commitHash?: string }).commitHash = commitHash;
      }
    }
    logger.log("mark as approved: hasChanges", hasChanges);
    message.approvalState = "approved";

    return {
      updatedFiles: hasChanges,
      extraFiles: uncommittedFiles.length > 0 ? uncommittedFiles : undefined,
      extraFilesError,
    };
  } catch (error: unknown) {
    logger.error("Error processing files:", error);
    return { error: (error as any).toString() };
  } finally {
    const appendedContent = `
    ${warnings
      .map(
        (warning) =>
          `<atlarix-output type="warning" message="${warning.message}">${warning.error}</atlarix-output>`,
      )
      .join("\n")}
    ${errors
      .map(
        (error) =>
          `<atlarix-output type="error" message="${error.message}">${error.error}</atlarix-output>`,
      )
      .join("\n")}
    `;
    if (appendedContent.length > 0 && ephemeralChat) {
      const target = ephemeralChat.messages.find((m) => m.id === messageId);
      if (target) {
        target.content = fullResponse + "\n\n" + appendedContent;
      }
    }
  }
}
