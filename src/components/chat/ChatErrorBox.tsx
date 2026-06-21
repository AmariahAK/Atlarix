import { IpcClient } from "@/ipc/ipc_client";
import { triggerUpgrade } from "@/hooks/useUpgrade";
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

/** Open Settings → AI so the user can switch provider / model or add an API key. */
function openAiSettings() {
  openSettingsSection("ai");
}

/** Stable phrases emitted by the Compass token-pool guard (see compass_constants.ts). */
const COMPASS_EXHAUSTED_MARKER = "Atlarix Core usage for this month is over";
const COMPASS_REACHABILITY_MARKER = "trouble reaching Atlarix Core";

export function ChatErrorBox({
  onDismiss,
  error,
  isAtlarixProEnabled,
}: {
  onDismiss: () => void;
  error: string;
  isAtlarixProEnabled: boolean;
}) {
  // Atlarix Core monthly token pool exhausted — offer upgrade + switch to
  // another provider/model (BYOK) without losing the chat.
  if (error.includes(COMPASS_EXHAUSTED_MARKER)) {
    return (
      <ChatInfoContainer onDismiss={onDismiss}>
        <span>{error.replace(AI_STREAMING_ERROR_MESSAGE_PREFIX, "")}</span>
        <div className="mt-2 space-y-2 space-x-2">
          {!isAtlarixProEnabled && (
            <UpgradeButton>Upgrade for more</UpgradeButton>
          )}
          <SwitchProviderButton>Choose another model</SwitchProviderButton>
        </div>
      </ChatInfoContainer>
    );
  }

  // Transient: couldn't reach Atlarix Core — retry or switch provider.
  if (error.includes(COMPASS_REACHABILITY_MARKER)) {
    return (
      <ChatInfoContainer onDismiss={onDismiss}>
        <span>{error.replace(AI_STREAMING_ERROR_MESSAGE_PREFIX, "")}</span>
        <div className="mt-2 space-y-2 space-x-2">
          <SwitchProviderButton>Switch provider</SwitchProviderButton>
        </div>
      </ChatInfoContainer>
    );
  }

  if (error.includes("doesn't have a free quota tier")) {
    return (
      <ChatErrorContainer onDismiss={onDismiss}>
        {error}
        <span className="ml-1">
          <UpgradeButton>
            Access with Atlarix Pro
          </UpgradeButton>
        </span>{" "}
        or switch to another model.
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
  // Sometimes Atlarix Pro can return rate limit errors and we do not want to
  // show the upgrade to Atlarix Pro link in that case because they are
  // already on the Atlarix Pro plan.
  if (
    !isAtlarixProEnabled &&
    (error.includes("Resource has been exhausted") ||
      error.includes("https://ai.google.dev/gemini-api/docs/rate-limits") ||
      error.includes("Provider returned error"))
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

  if (error.includes("LiteLLM Virtual Key expected")) {
    return (
      <ChatInfoContainer onDismiss={onDismiss}>
        <span>
          Looks like you don't have a valid Atlarix Pro key.{" "}
          <UpgradeButton>
            Upgrade to Atlarix Pro
          </UpgradeButton>{" "}
          today.
        </span>
      </ChatInfoContainer>
    );
  }
  if (isAtlarixProEnabled && error.includes("ExceededBudget:")) {
    return (
      <ChatInfoContainer onDismiss={onDismiss}>
        <span>
          You have used all of your Atlarix AI credits this month.{" "}
          <ExternalLink
            href="https://atlarix.dev/subscription?utm_source=atlarix-app&utm_medium=app&utm_campaign=exceeded-budget-error"
            variant="primary"
          >
            Reload or upgrade your subscription
          </ExternalLink>{" "}
          and get more AI credits
        </span>
      </ChatInfoContainer>
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

/**
 * Upgrade button that opens LemonSqueezy checkout (requires sign-in)
 */
function UpgradeButton({ children }: { children: React.ReactNode }) {
  const baseClasses =
    "cursor-pointer inline-flex items-center gap-1.5 rounded-md px-3 py-1.5 text-sm font-medium shadow-sm focus:outline-none focus:ring-2";
  const primaryClasses =
    "bg-blue-600 text-white hover:bg-blue-700 focus:ring-blue-500";

  return (
    <a
      className={`${baseClasses} ${primaryClasses}`}
      onClick={() => triggerUpgrade()}
    >
      <span>{children}</span>
      <CircleArrowUp size={18} />
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
