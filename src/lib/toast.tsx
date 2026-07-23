import { toast } from "sonner";
import type { PostHog } from "posthog-js";
import { CustomErrorToast } from "../components/CustomErrorToast";
import { InputRequestToast } from "../components/InputRequestToast";
import { McpConsentToast } from "../components/McpConsentToast";

/**
 * Toast utility functions for consistent notifications across the app
 */

/**
 * Show a success toast
 * @param message The message to display
 */
export const showSuccess = (message: string) => {
  toast.success(message);
};

/**
 * Show an error toast
 * @param message The error message to display
 */
export const showError = (message: any) => {
  const errorMessage = message.toString();
  console.error(message);

  const onCopy = (toastId: string | number) => {
    navigator.clipboard.writeText(errorMessage);

    // Update the toast to show the 'copied' state
    toast.custom(
      (t) => (
        <CustomErrorToast
          message={errorMessage}
          toastId={t}
          copied={true}
          onCopy={() => onCopy(t)}
        />
      ),
      { id: toastId, duration: Infinity },
    );

    // After 2 seconds, revert the toast back to the original state
    setTimeout(() => {
      toast.custom(
        (t) => (
          <CustomErrorToast
            message={errorMessage}
            toastId={t}
            copied={false}
            onCopy={() => onCopy(t)}
          />
        ),
        { id: toastId, duration: Infinity },
      );
    }, 2000);
  };

  // Use custom error toast with enhanced features
  const toastId = toast.custom(
    (t) => (
      <CustomErrorToast
        message={errorMessage}
        toastId={t}
        onCopy={() => onCopy(t)}
      />
    ),
    { duration: 8_000 },
  );

  return toastId;
};

/**
 * Show a warning toast
 * @param message The warning message to display
 */
export const showWarning = (message: string) => {
  toast.warning(message);
  console.warn(message);
};

/**
 * Show an info toast
 * @param message The info message to display
 */
export const showInfo = (message: string) => {
  toast.info(message);
};

/**
 * Show an input request toast for interactive prompts (y/n)
 * @param message The prompt message to display
 * @param onResponse Callback function called when user responds
 */
export const showInputRequest = (
  message: string,
  onResponse: (response: "y" | "n") => void,
) => {
  const toastId = toast.custom(
    (t) => (
      <InputRequestToast
        message={message}
        toastId={t}
        onResponse={onResponse}
      />
    ),
    { duration: Infinity }, // Don't auto-close
  );

  return toastId;
};

export function showMcpConsentToast(args: {
  serverName: string;
  toolName: string;
  toolDescription?: string | null;
  inputPreview?: string | null;
  onDecision: (d: "accept-once" | "accept-always" | "decline") => void;
}) {
  const toastId = toast.custom(
    (t) => (
      <McpConsentToast
        toastId={t}
        serverName={args.serverName}
        toolName={args.toolName}
        toolDescription={args.toolDescription}
        inputPreview={args.inputPreview}
        onDecision={args.onDecision}
      />
    ),
    { duration: Infinity },
  );
  return toastId;
}

export const showExtraFilesToast = ({
  files,
  error,
  posthog,
}: {
  files: string[];
  error?: string;
  posthog: PostHog;
}) => {
  // NEVER send `files` — these are absolute paths, which leak the project's
  // structure and usually the OS username (/Users/<name>/…). The user consented
  // to usage analytics, explicitly "no code, no prompts, no personal info"; a
  // path list is all three by implication. The count is what the event is for.
  if (error) {
    showError(
      `Error committing files ${files.join(", ")} changed outside of Atlarix: ${error}`,
    );
    posthog.capture("extra_files_error", {
      file_count: files.length,
      error,
    });
  } else {
    showWarning(
      `Files changed outside of Atlarix have automatically been committed:
    \n\n${files.join("\n")}`,
    );
    posthog.capture("extra_files_warning", {
      file_count: files.length,
    });
  }
};

// Re-export for direct use
export { toast };
