/** @jsxImportSource @opentui/react */
/**
 * A short message in the top-right corner (opencode's toasts): "Connected",
 * "Updating to v14.53.0…", "Copied". One at a time; it goes by itself. The
 * left/right bars take the variant's colour.
 */
import { color } from "./theme";

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

export function Toast({ toast, width }: { toast: ToastState; width: number }) {
  return (
    <box
      position="absolute"
      top={1}
      right={2}
      zIndex={200}
      maxWidth={Math.min(60, width - 6)}
      backgroundColor={color.panel}
      border={["left", "right"]}
      borderColor={BAR[toast.variant]}
      paddingLeft={2}
      paddingRight={2}
      paddingTop={1}
      paddingBottom={1}
    >
      <text fg={toast.variant === "error" ? color.error : color.text} wrapMode="word">
        {toast.message}
      </text>
    </box>
  );
}
