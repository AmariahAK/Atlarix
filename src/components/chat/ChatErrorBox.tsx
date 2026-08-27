import { IpcClient } from "@/ipc/ipc_client";
import {
  X,
  ExternalLink as ExternalLinkIcon,
  CircleArrowUp,
  SlidersHorizontal,
} from "lucide-react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { openSettingsSection } from "@/lib/open-settings-section";
import { AI_STREAMING_ERROR_MESSAGE_PREFIX } from "@/shared/texts";
import {
  CORE_EXHAUSTED_MARKER,
  CORE_REACHABILITY_MARKER,
} from "@/shared/billing_copy";

/** Open Settings → AI so the user can switch provider / model or add an API key. */
function openAiSettings() {
  openSettingsSection("ai");
}

// The markers are IMPORTED, not re-declared. They used to be typed out here as
// substrings of copy that lives elsewhere, so rewording that copy silently
// deleted the "Top up credit" button from the error that most needs it — nothing
// failed, nothing logged, the button was just gone.

export function ChatErrorBox({
  onDismiss,
  error,
}: {
  onDismiss: () => void;
  error: string;
}) {
  // Atlarix Core credit used up (PAYG) — top up, or switch to a BYOK model,
  // without losing the chat.
  if (error.includes(CORE_EXHAUSTED_MARKER)) {
    return (
      <ChatInfoContainer onDismiss={onDismiss}>
        <span>{error.replace(AI_STREAMING_ERROR_MESSAGE_PREFIX, "")}</span>
        <div className="mt-2 space-y-2 space-x-2">
          <TopUpButton>Top up credit</TopUpButton>
          <SwitchProviderButton>Choose another model</SwitchProviderButton>
        </div>
      </ChatInfoContainer>
    );
  }

  // Transient: couldn't reach Atlarix Core — retry or switch provider.
  if (error.includes(CORE_REACHABILITY_MARKER)) {
    return (
      <ChatInfoContainer onDismiss={onDismiss}>
        <span>{error.replace(AI_STREAMING_ERROR_MESSAGE_PREFIX, "")}</span>
        <div className="mt-2 space-y-2 space-x-2">
          <SwitchProviderButton>Switch provider</SwitchProviderButton>
        </div>
      </ChatInfoContainer>
    );
  }

  // A THIRD-PARTY provider's free tier, not ours. This used to offer "Access with
  // Atlarix Pro", which was wrong on both counts: buying Pro does nothing about
  // Google's quota, and Pro does not gate AI in the first place. The two things
  // that actually work are Atlarix Core and another model.
  if (error.includes("doesn't have a free quota tier")) {
    return (
      <ChatErrorContainer onDismiss={onDismiss}>
        {error}
        <div className="mt-2 space-y-2 space-x-2">
          <SwitchProviderButton>Choose another model</SwitchProviderButton>
        </div>
      </ChatErrorContainer>
    );
  }

  // Stream stalled (45s watchdog) — retry or switch models.
  if (error.includes("Stream stalled")) {
    return (
      <ChatErrorContainer onDismiss={onDismiss}>
        The model stopped responding mid-stream. Try sending your message again or
        switch to another model.
      </ChatErrorContainer>
    );
  }

  // Stream stalled mid-tool-call (watchdog) — not fixable by upgrading; docs + retry only.
  if (
    error.includes("Stream paused:") ||
    error.includes("while a tool call was pending")
  ) {
    return (
      <ChatErrorContainer onDismiss={onDismiss}>
        {error}
        <div className="mt-2 space-y-2 space-x-2">
          <ExternalLink href="https://www.atlarix.dev/docs/faq">
            Read docs
          </ExternalLink>
        </div>
      </ChatErrorContainer>
    );
  }

  // Important, this needs to come after the "free quota tier" check
  // because it also includes this URL in the error message
  //
  if (
    error.includes("Resource has been exhausted") ||
    error.includes("https://ai.google.dev/gemini-api/docs/rate-limits") ||
    error.includes("Provider returned error")
  ) {
    return (
      <ChatErrorContainer onDismiss={onDismiss}>
        {error}
        <div className="mt-2 space-y-2 space-x-2">
          <ExternalLink href="https://atlarix.dev/docs/help/ai-rate-limit">
            Troubleshooting guide
          </ExternalLink>
        </div>
      </ChatErrorContainer>
    );
  }

  // This is a very long list of model fallbacks that clutters the error message.
  //
  // We are matching "Fallbacks=[{" and not just "Fallbacks=" because the fallback
  // model itself can error and we want to include the fallback model error in the error message.
  // Example: https://github.com/norahlabs/atlarix/issues/1849#issuecomment-3590685911
  const fallbackPrefix = "Fallbacks=[{";
  if (error.includes(fallbackPrefix)) {
    error = error.split(fallbackPrefix)[0];
  }
  return (
    <ChatErrorContainer onDismiss={onDismiss}>
      {error}
      <div className="mt-2 space-y-2 space-x-2">
        <ExternalLink href="https://www.atlarix.dev/docs/faq">
          Read docs
        </ExternalLink>
      </div>
    </ChatErrorContainer>
  );
}

function ExternalLink({
  href,
  children,
  variant = "secondary",
  icon,
}: {
  href: string;
  children: React.ReactNode;
  variant?: "primary" | "secondary";
  icon?: React.ReactNode;
}) {
  const baseClasses =
    "cursor-pointer inline-flex items-center gap-1.5 rounded-md px-3 py-1.5 text-sm font-medium shadow-sm focus:outline-none focus:ring-2";
  const primaryClasses =
    "bg-blue-600 text-white hover:bg-blue-700 focus:ring-blue-500";
  const secondaryClasses =
    "bg-blue-50 text-blue-700 border border-blue-200 hover:bg-blue-100 hover:border-blue-300 focus:ring-blue-200";
  const iconElement =
    icon ??
    (variant === "primary" ? (
      <CircleArrowUp size={18} />
    ) : (
      <ExternalLinkIcon size={14} />
    ));

  return (
    <a
      className={`${baseClasses} ${variant === "primary" ? primaryClasses : secondaryClasses
        }`}
      onClick={() => IpcClient.getInstance().openExternalUrl(href)}
    >
      <span>{children}</span>
      {iconElement}
    </a>
  );
}

/** Opens Settings → AI where the Atlarix Core credit balance + top-up live. */
function TopUpButton({ children }: { children: React.ReactNode }) {
  const baseClasses =
    "cursor-pointer inline-flex items-center gap-1.5 rounded-md px-3 py-1.5 text-sm font-medium shadow-sm focus:outline-none focus:ring-2";
  const primaryClasses =
    "bg-blue-600 text-white hover:bg-blue-700 focus:ring-blue-300";
  return (
    <a className={`${baseClasses} ${primaryClasses}`} onClick={openAiSettings}>
      <span>{children}</span>
      <CircleArrowUp size={14} />
    </a>
  );
}

/** Opens Settings → AI so the user can switch provider / model (BYOK) or add a key. */
function SwitchProviderButton({ children }: { children: React.ReactNode }) {
  const baseClasses =
    "cursor-pointer inline-flex items-center gap-1.5 rounded-md px-3 py-1.5 text-sm font-medium shadow-sm focus:outline-none focus:ring-2";
  const secondaryClasses =
    "bg-blue-50 text-blue-700 border border-blue-200 hover:bg-blue-100 hover:border-blue-300 focus:ring-blue-200";
  return (
    <a className={`${baseClasses} ${secondaryClasses}`} onClick={openAiSettings}>
      <span>{children}</span>
      <SlidersHorizontal size={14} />
    </a>
  );
}

function ChatErrorContainer({
  onDismiss,
  children,
}: {
  onDismiss: () => void;
  children: React.ReactNode | string;
}) {
  return (
    <div className="relative mt-2 bg-red-50 border border-red-200 rounded-md shadow-sm p-2 mx-4">
      <button
        onClick={onDismiss}
        className="absolute top-2.5 left-2 p-1 hover:bg-red-100 rounded"
      >
        <X size={14} className="text-red-500" />
      </button>
      <div className="pl-8 py-1 text-sm">
        <div className="text-red-700 text-wrap">
          {typeof children === "string" ? (
            <ReactMarkdown
              remarkPlugins={[remarkGfm]}
              components={{
                a: ({ children: linkChildren, ...props }) => (
                  <a
                    {...props}
                    onClick={(e) => {
                      e.preventDefault();
                      if (props.href) {
                        IpcClient.getInstance().openExternalUrl(props.href);
                      }
                    }}
                    className="text-blue-500 hover:text-blue-700"
                  >
                    {linkChildren}
                  </a>
                ),
              }}
            >
              {children}
            </ReactMarkdown>
          ) : (
            children
          )}
        </div>
      </div>
    </div>
  );
}

function ChatInfoContainer({
  onDismiss,
  children,
}: {
  onDismiss: () => void;
  children: React.ReactNode;
}) {
  return (
    <div className="relative mt-2 bg-sky-50 border border-sky-200 rounded-md shadow-sm p-2 mx-4">
      <button
        onClick={onDismiss}
        className="absolute top-2.5 left-2 p-1 hover:bg-sky-100 rounded"
      >
        <X size={14} className="text-sky-600" />
      </button>
      <div className="pl-8 py-1 text-sm">
        <div className="text-sky-800 text-wrap">{children}</div>
      </div>
    </div>
  );
}
