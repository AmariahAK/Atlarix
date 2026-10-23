/** @jsxImportSource @opentui/react */
/**
 * A short message in the top-right corner (opencode's toasts): "Connected",
 * "Updating to v14.53.0…", "Copied". One at a time; it goes by itself. The
 * left/right bars take the variant's colour.
 */
import { color } from "./theme";
import { linkify } from "./links";
import { displayWidth } from "./Prose";

export type ToastVariant = "info" | "success" | "warn" | "error";

export interface ToastState {
  message: string;
  variant: ToastVariant;
}

const BAR: Record<ToastVariant, string> = {
  info: color.textDim,
  success: color.accent,
  warn: color.warn,
  error: color.error,
};

/** The left/right bars and the padding inside them. */
const CHROME = 6;

export function Toast({ toast, width }: { toast: ToastState; width: number }) {
  // A WIDTH, not only a maxWidth. With maxWidth alone the box took the text's
  // unwrapped width, the cap squeezed it, and its height stayed one row: every
  // wrapped line after the first was cut off (QA A4). Given a width, the text
  // wraps inside it and the box grows to fit.
  const cap = Math.min(60, width - 6);
  const boxWidth = Math.max(CHROME + 1, Math.min(cap, displayWidth(toast.message) + CHROME));
  return (
    <box
      position="absolute"
      top={1}
      right={2}
      zIndex={200}
      width={boxWidth}
      backgroundColor={color.panel}
      border={["left", "right"]}
      borderColor={BAR[toast.variant]}
      paddingLeft={2}
      paddingRight={2}
      paddingTop={1}
      paddingBottom={1}
    >
      <text fg={toast.variant === "error" ? color.error : color.text} wrapMode="word">
        {linkify(toast.message)}
      </text>
    </box>
  );
}
