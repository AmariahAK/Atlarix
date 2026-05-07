/**
 * Atlarix Plugin Service - v7.1.2
 * Atlarix-specific hook-based plugin extensibility.
 *
 * This is a lightweight alternative to OpenCode's Effect-based plugin system.
 * Plugins register hooks that are called at key lifecycle points.
 */

import { Log } from "../logging";
import { AtlarixError } from "../errors";

const logger = Log.scope("plugin-service");

export type HookPhase =
  | "tool:beforeExecute"
  | "tool:afterExecute"
  | "session:beforeCompact"
  | "session:afterCompact"
  | "session:beforeSummarize"
  | "session:afterSummarize"
  | "chat:preProcess"
  | "chat:postProcess"
  | "model:beforeCall"
  | "model:afterCall"
  | "error:beforeHandle"
  | "error:afterHandle";

export interface HookContext {
  chatId?: number;
  workspaceId?: number;
  toolName?: string;
  timestamp: Date;
}

export type HookHandler = (
  context: HookContext,
  data: Record<string, unknown>
) => Promise<void>;

export interface Plugin {
  id: string;
  name: string;
  version: string;
  hooks: Partial<Record<HookPhase, HookHandler>>;
  initialize?: () => Promise<void>;
  dispose?: () => Promise<void>;
}

export class PluginService {
  private plugins = new Map<string, Plugin>();
  private hookHandlers = new Map<HookPhase, HookHandler[]>();
  private initialized = false;

  async initialize(): Promise<void> {
    if (this.initialized) return;
    this.initialized = true;
    logger.info("Plugin service initialized", { pluginCount: this.plugins.size });
  }

  async dispose(): Promise<void> {
    for (const [id, plugin] of this.plugins) {
      try {
        await plugin.dispose?.();
      } catch (error) {
        logger.error(`Failed to dispose plugin ${id}`, { error });
      }
    }
    this.plugins.clear();
    this.hookHandlers.clear();
    this.initialized = false;
    logger.info("Plugin service disposed");
  }

  register(plugin: Plugin): void {
    if (this.plugins.has(plugin.id)) {
      logger.warn(`Plugin ${plugin.id} already registered, skipping`);
      return;
    }

    this.plugins.set(plugin.id, plugin);

    for (const [phase, handler] of Object.entries(plugin.hooks) as [HookPhase, HookHandler][]) {
      if (!this.hookHandlers.has(phase)) {
        this.hookHandlers.set(phase, []);
      }
      this.hookHandlers.get(phase)!.push(handler);
    }

    logger.info(`Registered plugin: ${plugin.name} v${plugin.version}`, {
      id: plugin.id,
      hooks: Object.keys(plugin.hooks),
    });
  }

  unregister(pluginId: string): void {
    const plugin = this.plugins.get(pluginId);
    if (!plugin) return;

    for (const [phase, handler] of Object.entries(plugin.hooks) as [HookPhase, HookHandler][]) {
      const handlers = this.hookHandlers.get(phase);
      if (handlers) {
        const idx = handlers.indexOf(handler);
        if (idx !== -1) handlers.splice(idx, 1);
      }
    }

    this.plugins.delete(pluginId);
    logger.info(`Unregistered plugin: ${pluginId}`);
  }

  async triggerHook(phase: HookPhase, context: HookContext, data: Record<string, unknown>): Promise<void> {
    const handlers = this.hookHandlers.get(phase);
    if (!handlers || handlers.length === 0) return;

    const span = logger.time(`${phase}`);
    try {
      await Promise.all(
        handlers.map(async (handler) => {
          try {
            await handler(context, data);
          } catch (error) {
            logger.error(`Hook ${phase} failed in handler`, {
              error: error instanceof Error ? error.message : String(error),
              plugin: context.chatId,
            });
          }
        })
      );
    } finally {
      span.dispose();
    }
  }

  listPlugins(): Array<{ id: string; name: string; version: string }> {
    return Array.from(this.plugins.values()).map((p) => ({
      id: p.id,
      name: p.name,
      version: p.version,
    }));
  }

  hasPlugin(id: string): boolean {
    return this.plugins.has(id);
  }
}

export const pluginService = new PluginService();

export function createPlugin(definition: Omit<Plugin, "id"> & { id: string }): Plugin {
  return {
    ...definition,
    hooks: definition.hooks ?? {},
  };
}

export async function withPluginContext<T>(
  chatId: number | undefined,
  workspaceId: number | undefined,
  fn: () => Promise<T>
): Promise<T> {
  const context: HookContext = {
    chatId,
    workspaceId,
    timestamp: new Date(),
  };

  try {
    await pluginService.triggerHook("chat:preProcess", context, {});
    const result = await fn();
    await pluginService.triggerHook("chat:postProcess", context, { success: true });
    return result;
  } catch (error) {
    await pluginService.triggerHook("error:beforeHandle", context, { error });
    await pluginService.triggerHook("chat:postProcess", context, { success: false, error });
    throw error;
  }
}