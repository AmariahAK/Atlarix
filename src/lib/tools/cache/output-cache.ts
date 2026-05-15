/**
 * Tool Output Cache - v7.1.2
 * Writes large tool outputs to disk, returns preview.
 * Inspired by OpenCode's truncation system.
 *
 * Browser-safe: In renderer context, this operates in passthrough mode (no caching).
 * Caching only works in main process where Node.js APIs are available.
 */

import { Log } from "../../logging";
import { isMainProcessNode } from "../../runtime/is-main-node";

const logger = Log.scope("tool-output-cache");

const MAX_PREVIEW_LINES = 50;
const MAX_PREVIEW_CHARS = 2000;
const RETENTION_DAYS = 7;

interface CachedOutput {
  filePath: string;
  originalSize: number;
  /** Date when written; may be string after JSON.parse恢复 */
  cachedAt: Date | string;
  toolName: string;
}

export class ToolOutputCache {
  private cacheDir: string | null = null;
  private index = new Map<string, CachedOutput>();
  private initialized = false;
  private nodeFs: typeof import("fs") | null = null;
  private nodePath: typeof import("path") | null = null;

  constructor(cacheDir?: string) {
    if (cacheDir) {
      this.cacheDir = cacheDir;
    } else if (isMainProcessNode()) {
      // Lazy load Node.js modules only in main process
      this.initNodeModules();
    }
  }

  private initNodeModules(): void {
    try {
      const fsMod: typeof import("fs") = require("fs");
      const pathMod: typeof import("path") = require("path");
      this.nodeFs = fsMod;
      this.nodePath = pathMod;
      const homeDir = process.env.HOME || "/tmp";
      this.cacheDir = pathMod.join(homeDir, ".atlarix/tool-outputs");
    } catch (e) {
      logger.warn("Failed to load Node.js modules for tool output cache", { error: e });
    }
  }

  async initialize(): Promise<void> {
    if (this.initialized) return;
    this.initialized = true;

    // Passthrough mode in browser
    if (!this.cacheDir || !this.nodeFs) {
      return;
    }

    try {
      if (!this.nodeFs.existsSync(this.cacheDir)) {
        this.nodeFs.mkdirSync(this.cacheDir, { recursive: true });
      }
      await this.loadIndex();
      await this.cleanupExpired();
      logger.info("[tool-output-cache] initialized");
    } catch (err) {
      logger.warn("[tool-output-cache] init failed", {
        cachePath: this.cacheDir,
        error: err instanceof Error
          ? { message: err.message, code: (err as NodeJS.ErrnoException).code }
          : String(err)
      });
    }
  }

  private getCacheKey(operationId: string): string {
    return operationId.replace(/[^a-zA-Z0-9_-]/g, "_");
  }

  private createPreview(content: string): string {
    const lines = content.split("\n");
    if (lines.length > MAX_PREVIEW_LINES) {
      return lines.slice(0, MAX_PREVIEW_LINES).join("\n") + "\n... [truncated, full output cached]";
    }
    if (content.length > MAX_PREVIEW_CHARS) {
      return content.slice(0, MAX_PREVIEW_CHARS) + "\n... [truncated, full output cached]";
    }
    return content;
  }

  /**
   * Cache a tool output if it exceeds the threshold.
   * Returns preview text if cached, original text if not.
   */
  async cacheIfLarge(
    toolName: string,
    operationId: string,
    content: string,
    thresholdChars: number = 10000
  ): Promise<string> {
    // Browser/renderer environment - passthrough
    if (!this.cacheDir || !this.nodeFs) {
      return content;
    }

    await this.initialize();

    if (content.length < thresholdChars) {
      return content;
    }

    const cacheKey = this.getCacheKey(operationId);
    const cachePath = this.nodePath!.join(this.cacheDir, `${cacheKey}.txt`);
    const preview = this.createPreview(content);

    try {
      this.nodeFs.writeFileSync(cachePath, content, "utf-8");

      this.index.set(cacheKey, {
        filePath: cachePath,
        originalSize: content.length,
        cachedAt: new Date(),
        toolName,
      });

      await this.saveIndex();

      logger.debug("Cached large tool output", {
        tool: toolName,
        operationId,
        originalSize: content.length,
        cacheKey,
      });

      return preview;
    } catch (error) {
      logger.error("Failed to cache tool output", { error, toolName, operationId });
      return content;
    }
  }

  /**
   * Retrieve cached content (full).
   */
  async retrieve(operationId: string): Promise<string | null> {
    if (!this.cacheDir || !this.nodeFs) {
      return null;
    }

    await this.initialize();

    const cacheKey = this.getCacheKey(operationId);
    const cached = this.index.get(cacheKey);

    if (!cached) return null;

    try {
      return this.nodeFs.readFileSync(cached.filePath, "utf-8");
    } catch (error) {
      logger.warn("Failed to read cached output", { error, operationId });
      return null;
    }
  }

  /**
   * Check if content is cached.
   */
  async has(operationId: string): Promise<boolean> {
    if (!this.cacheDir || !this.nodeFs) {
      return false;
    }

    await this.initialize();
    return this.index.has(this.getCacheKey(operationId));
  }

  private async getIndexPath(): Promise<string | null> {
    if (!this.cacheDir) return null;
    return this.nodePath!.join(this.cacheDir, "index.json");
  }

  private async loadIndex(): Promise<void> {
    if (!this.cacheDir || !this.nodeFs) return;

    try {
      const indexPath = await this.getIndexPath();
      if (!indexPath) return;

      if (this.nodeFs.existsSync(indexPath)) {
        const data = this.nodeFs.readFileSync(indexPath, "utf-8");
        const parsed = JSON.parse(data) as [string, CachedOutput][];
        this.index = new Map(parsed);
      }
    } catch (error) {
      logger.warn("Failed to load cache index", { error });
      this.index = new Map();
    }
  }

  private async saveIndex(): Promise<void> {
    if (!this.cacheDir || !this.nodeFs) return;

    try {
      const indexPath = await this.getIndexPath();
      if (!indexPath) return;

      const data = JSON.stringify(Array.from(this.index.entries()));
      this.nodeFs.writeFileSync(indexPath, data, "utf-8");
    } catch (error) {
      logger.warn("Failed to save cache index", { error });
    }
  }

  private async cleanupExpired(): Promise<void> {
    if (!this.cacheDir || !this.nodeFs) return;

    const now = Date.now();
    const maxAge = RETENTION_DAYS * 24 * 60 * 60 * 1000;
    const expired: string[] = [];

    for (const [key, cached] of this.index.entries()) {
      if (now - new Date(cached.cachedAt).getTime() > maxAge) {
        expired.push(key);
      }
    }

    for (const key of expired) {
      const cached = this.index.get(key);
      if (cached) {
        try {
          this.nodeFs!.unlinkSync(cached.filePath);
        } catch {
          // File already gone
        }
        this.index.delete(key);
      }
    }

    if (expired.length > 0) {
      await this.saveIndex();
    }
  }
}

let _instance: ToolOutputCache | null = null;

export function getToolOutputCache(): ToolOutputCache {
  if (!_instance) {
    _instance = new ToolOutputCache();
  }
  return _instance;
}

// Convenience exports
export const toolOutputCache = {
  cacheIfLarge: (
    toolName: string,
    operationId: string,
    content: string,
    thresholdChars: number = 10000
  ) => getToolOutputCache().cacheIfLarge(toolName, operationId, content, thresholdChars),
  retrieve: (operationId: string) => getToolOutputCache().retrieve(operationId),
  has: (operationId: string) => getToolOutputCache().has(operationId),
};