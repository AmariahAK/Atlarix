import log from "electron-log";
import {
  ENV_SECRET_BLOCK_MESSAGE,
  PATH_ESCAPE_BLOCK_MESSAGE,
} from "@/lib/security/env-secret-paths";

const logger = log.scope("read_file");

export type ReadFileErrorCode =
  | "file_not_found"
  | "not_a_file"
  | "path_not_allowed"
  | "read_failed"
  | "missing_path";

export type ReadFileStructuredError = {
  success: false;
  error: ReadFileErrorCode;
  path?: string;
  message: string;
};

function nodeErrno(err: unknown): string | undefined {
  return (err as NodeJS.ErrnoException)?.code;
}

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export function readFileStructuredError(
  err: unknown,
  displayPath?: string,
): ReadFileStructuredError | null {
  const path = displayPath;
  const msg = errMessage(err);
  const code = nodeErrno(err);

  if (code === "ENOENT") {
    const p = path ?? "requested path";
    return {
      success: false,
      error: "file_not_found",
      path,
      message: `No file at path "${p}". Use list_files or explore_folder to find the correct path.`,
    };
  }

  if (
    code === "EISDIR" ||
    msg.includes("is a directory") ||
    msg.toLowerCase().includes("not a file")
  ) {
    const p = path ?? "requested path";
    return {
      success: false,
      error: "not_a_file",
      path,
      message: `Path "${p}" is a directory, not a file. Use explore_folder or list_files.`,
    };
  }

  if (
    msg.startsWith("Invalid path:") ||
    msg.includes("looks like an absolute") ||
    msg.includes("UNC paths are not allowed") ||
    msg.includes('".." is not allowed')
  ) {
    return {
      success: false,
      error: "path_not_allowed",
      path,
      message: msg,
    };
  }

  if (
    msg === PATH_ESCAPE_BLOCK_MESSAGE ||
    msg === ENV_SECRET_BLOCK_MESSAGE ||
    msg.includes("escapes workspace") ||
    msg.includes("secret") ||
    msg.includes("not allowed")
  ) {
    return {
      success: false,
      error: "path_not_allowed",
      path,
      message: msg,
    };
  }

  return null;
}

export function enrichReadFileStructuredError(
  base: ReadFileStructuredError,
  inventoryHint: string,
): ReadFileStructuredError {
  const hint = inventoryHint.trim();
  if (!hint) return base;
  return {
    ...base,
    message: `${base.message} ${hint}`.trim(),
  };
}

export function logReadFileError(structured: ReadFileStructuredError): void {
  logger.debug(structured.message, { error: structured.error, path: structured.path });
}

export function logReadFileUnexpected(err: unknown, displayPath?: string): void {
  logger.warn("read_file failed", { path: displayPath, err });
}
