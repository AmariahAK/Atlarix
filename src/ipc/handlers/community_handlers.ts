import log from "electron-log";
import type { DiscordInviteInfoResult } from "../ipc_types";
import { createLoggedHandler } from "./safe_handle";

const logger = log.scope("community_handlers");
const handle = createLoggedHandler(logger);

const DISCORD_INVITE_CODE = "7pwtr3t3nD";

export function registerCommunityHandlers() {
  handle(
    "discord:get-invite-info",
    async (): Promise<DiscordInviteInfoResult> => {
      try {
        const url = `https://discord.com/api/v10/invites/${DISCORD_INVITE_CODE}?with_counts=true`;
        const res = await fetch(url, {
          headers: { Accept: "application/json" },
        });
        if (!res.ok) {
          logger.warn("Discord invite fetch failed:", res.status);
          return { ok: false };
        }
        const data = (await res.json()) as {
          guild?: { name?: string; description?: string | null };
          approximate_member_count?: number;
          approximate_presence_count?: number;
        };
        const name = data.guild?.name?.trim() || "Atlarix Community";
        const description =
          typeof data.guild?.description === "string"
            ? data.guild.description.trim() || null
            : null;
        return {
          ok: true,
          name,
          description,
          memberCount: data.approximate_member_count,
          presenceCount: data.approximate_presence_count,
        };
      } catch (e) {
        logger.warn("Discord invite fetch error:", e);
        return { ok: false };
      }
    },
  );
}
