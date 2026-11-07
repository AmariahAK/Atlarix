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

export { ACCOUNT_LABEL, type AccountKind } from "./header-account";

export function SessionHeader({
  version,
  model,
  mode,
  account,
  workspace,
  branch,
  mood,
  hint,
  computerUse,
}: {
  version: string;
  model: string;
  mode: string;
  /** The plan on Atlarix, else the provider (headerAccount). */
  account: string | null;
  /** Already shortened to fit. */
  workspace: string;
  /** The checked-out git branch, if the folder is a repository. */
  branch?: string | null;
  mood: RixMood;
  /** Lines under the header while the session is still empty. */
  hint?: ReactNode;
  /** Computer use is on for this model (the switch is shared with the app). */
  computerUse?: boolean;
}) {
  const line = [model, mode, account, computerUse ? "Computer use on" : null]
    .filter(Boolean)
    .join(" · ");
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
