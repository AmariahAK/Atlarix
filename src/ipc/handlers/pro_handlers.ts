import log from "electron-log";
import { createLoggedHandler } from "./safe_handle";
import { readSettings } from "../../main/settings"; // Assuming settings are read this way
import { UserBudgetInfo, UserBudgetInfoSchema } from "../ipc_types";
import { z } from "zod";

export const UserInfoResponseSchema = z.object({
  usedCredits: z.number(),
  totalCredits: z.number(),
  budgetResetDate: z.string(), // ISO date string from API
  userId: z.string(),
});

const logger = log.scope("pro_handlers");
const handle = createLoggedHandler(logger);

/** Shared fetch for use by other handlers (e.g. MCP free-tier limit). */
export async function fetchUserBudget(): Promise<UserBudgetInfo | null> {
  const settings = readSettings();
  const apiKey = settings.providerSettings?.auto?.apiKey?.value;
  if (!apiKey) return null;
  const url = "https://atlarix-api.fly.dev/v1/user/info";
  const headers = {
    "Content-Type": "application/json",
    Authorization: `Bearer ${apiKey}`,
  };
  try {
    const response = await fetch(url, { method: "GET", headers });
    if (!response.ok) return null;
    const rawData = await response.json();
    const data = UserInfoResponseSchema.parse(rawData);
    const redactedUserId =
      data.userId.length > 8 ? "****" + data.userId.slice(-4) : "<redacted>";
    return UserBudgetInfoSchema.parse({
      usedCredits: data.usedCredits,
      totalCredits: data.totalCredits,
      budgetResetDate: new Date(data.budgetResetDate),
      redactedUserId,
    });
  } catch {
    return null;
  }
}

export function registerProHandlers() {
  handle("get-user-budget", async (): Promise<UserBudgetInfo | null> => {
    logger.info("Attempting to fetch user budget information.");
    try {
      const userBudgetInfo = await fetchUserBudget();
      if (userBudgetInfo)
        logger.info("Successfully fetched user budget information.");
      return userBudgetInfo;
    } catch (error: any) {
      logger.error(`Error fetching user budget: ${error.message}`, error);
      return null;
    }
  });
}
