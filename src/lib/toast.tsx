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

/**
 * Reduce a git error to a BOUNDED label safe to transmit.
 *
 * A closed vocabulary, not a redaction pass. Scrubbing would mean guessing at
 * every shape a path can take on three platforms and losing once; matching known
 * git failures and emitting a constant cannot leak by construction, because the
 * returned string never contains any part of the input. The diagnostic value of
 * "which kind of failure" survives; "in which directory, for which user" does
 * not, and was never the point of the event.
 */
export function extraFilesErrorClass(error: string): string {
  const e = error.toLowerCase();
  if (e.includes("index.lock")) return "index_locked";
  if (e.includes("not a git repository")) return "not_a_repo";
  if (e.includes("permission denied") || e.includes("eacces"))
    return "permission_denied";
  if (e.includes("no space left") || e.includes("enospc")) return "disk_full";
  if (e.includes("would be overwritten") || e.includes("conflict"))
    return "conflict";
  if (e.includes("enoent")) return "missing_path";
  if (e.includes("nothing to commit")) return "nothing_to_commit";
  if (e.includes("author identity unknown") || e.includes("user.email"))
    return "identity_unset";
  return "other";
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
  //
  // AND NOT `error` EITHER — which is what this comment failed to stop. The raw
  // string is git's own message, and git quotes the paths it was working on, so
  // `error` routinely carries the very absolute paths the line above forbids.
  // The rule was written and then broken two lines below it, which is the usual
  // way: a comment is not a control. `extraFilesErrorClass` is the control.
  if (error) {
    showError(
      `Error committing files ${files.join(", ")} changed outside of Atlarix: ${error}`,
    );
    posthog.capture("extra_files_error", {
      file_count: files.length,
      error_class: extraFilesErrorClass(error),
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
