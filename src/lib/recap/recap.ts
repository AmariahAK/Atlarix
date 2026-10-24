/**
 * The session recap itself: one line, from the session's own model on the
 * session's own route (Atlarix Auto stays Auto, your key stays your key, Core
 * stays Core). When it is due is rules.ts; this only writes it.
 *
 * Nothing here is saved or added to the conversation: the recap is shown and
 * dropped, so the agent never reads its own summary back as something said.
 */
import { clampRecap, nearFreeLimit } from "./rules";

const RECAP_TIMEOUT_MS = 45_000;

const RECAP_SYSTEM = [
  "You write the one-line recap a user sees when they come back to an Atlarix session after stepping away.",
  "From the conversation, say in ONE plain sentence (two at most, under 60 words) what the task is, what is done, and what is next or waiting on them.",
  "No greeting, no preamble, no markdown, no lists. Name files or commands only if they matter.",
  "Say a file was changed only if it is in <files_changed_on_disk>; when that says none, nothing was changed on disk, whatever the conversation claims.",
].join(" ");

/** The ground truth the recap is held to (null: unknown, so nothing is said). */
function filesSection(files: string[] | null | undefined): string {
  if (files == null) return "";
  return `\n\n<files_changed_on_disk>\n${files.length ? files.join("\n") : "none"}\n</files_changed_on_disk>`;
}

/** Whether the shared setting allows recaps (unset = on). */
export async function recapEnabled(): Promise<boolean> {
  const { readSettings } = await import("@/main/settings");
  return (readSettings() as { sessionRecap?: boolean }).sessionRecap !== false;
}

export async function setRecapEnabled(on: boolean): Promise<void> {
  const { writeSettings } = await import("@/main/settings");
  writeSettings({ sessionRecap: on } as never);
}

/**
 * The recap, or null when none should be made (switched off, the free share
 * nearly gone, a BYOK conversation with no key that would otherwise go to
 * Core, nothing to summarise, or the model failed).
 */
export async function generateRecap(
  conversation: string,
  /** `force`: asked for (/recap), so the automatic-recap setting does not apply. */
  opts: {
    chatId: number | null;
    model?: { provider: string; name: string };
    force?: boolean;
    /** What the recent turns REALLY changed (changed-files.ts); the conversation's claims are not. */
    filesChanged?: string[] | null;
  },
): Promise<string | null> {
  if (!conversation.trim()) return null;
  if (!opts.force && !(await recapEnabled())) return null;
  const { readSettings } = await import("@/main/settings");
  const settings = readSettings();
  const chosen = opts.model ?? settings.selectedModel;
  if (chosen?.provider === "compass" && !opts.force) {
    const { latestAutoStatus } = await import("@/main/auto-status");
    if (nearFreeLimit(latestAutoStatus())) return null;
  }
  try {
    const { generateText } = await import("ai");
    const { getModelClient } = await import("@/ipc/utils/get_model_client");
    const { recordAuxUsage } = await import("@/lib/usage/turn-usage-aggregator");
    // No key for the provider: getModelClient throws, and there is no recap.
    const { modelClient } = await getModelClient(chosen, settings, { purpose: "summary" });
    const result = await generateText({
      model: modelClient.model,
      system: RECAP_SYSTEM,
      prompt: `<conversation>\n${conversation}\n</conversation>${filesSection(opts.filesChanged)}\n\nThe recap:`,
      abortSignal: AbortSignal.timeout(RECAP_TIMEOUT_MS),
    });
    recordAuxUsage(opts.chatId, result.usage, "recap");
    const line = clampRecap(result.text);
    return line || null;
  } catch {
    return null;
  }
}
