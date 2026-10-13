/** @jsxImportSource @opentui/react */
/**
 * The session header: Rix on the left, then who and where.
 *
 *   [Rix]  Atlarix v15.4.0
 *          GLM 5.3 · Build · Free
 *          ~/Documents/Github/AI  main
 *
 * It is the first thing inside the transcript's scroll, so it sits at the top
 * of a new session and scrolls away with the history instead of holding a
 * centred splash that vanishes on the first message.
 */
import type { ReactNode } from "react";
import { Rix, type RixMood } from "./Rix";
import { color } from "./theme";

export type AccountKind = "signed-out" | "free" | "pro" | "payg" | "own-key" | "local" | "endpoint";

export const ACCOUNT_LABEL: Record<AccountKind, string> = {
  "signed-out": "Not signed in",
  free: "Free",
  pro: "Pro",
  payg: "Pay as you go",
  "own-key": "Your key",
  local: "On this computer",
  /** A provider you added (an OpenAI-compatible address): it may need no key at all. */
  endpoint: "Your endpoint",
};

export function SessionHeader({
  version,
  model,
  mode,
  account,
  workspace,
  branch,
  mood,
  hint,
}: {
  version: string;
  model: string;
  mode: string;
  account: AccountKind | null;
  /** Already shortened to fit. */
  workspace: string;
  /** The checked-out git branch, if the folder is a repository. */
  branch?: string | null;
  mood: RixMood;
  /** Lines under the header while the session is still empty. */
  hint?: ReactNode;
}) {
  const line = [model, mode, account ? ACCOUNT_LABEL[account] : null].filter(Boolean).join(" · ");
  return (
    <box flexDirection="column" flexShrink={0} marginBottom={1}>
      <box flexDirection="row" gap={2}>
        <Rix mood={mood} />
        <box flexDirection="column">
          <text>
            <span fg={color.white}>
              <b>Atlarix</b>
            </span>
            <span fg={color.faint}>{` v${version}`}</span>
          </text>
          <text fg={color.textDim}>{line}</text>
          <text>
            <span fg={color.textDim}>{workspace}</span>
            {branch ? <span fg={color.code}>{`  ${branch}`}</span> : null}
          </text>
        </box>
      </box>
      {hint ? <box flexDirection="column" marginTop={1}>{hint}</box> : null}
    </box>
  );
}
