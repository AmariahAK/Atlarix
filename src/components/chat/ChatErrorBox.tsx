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
  AUTO_CONSENT_MARKER,
  CORE_EXHAUSTED_MARKER,
  CORE_REACHABILITY_MARKER,
  FREE_LIMIT_MARKER,
  ADD_CREDIT_LABEL,
  USE_OWN_KEY_LABEL,
  UPGRADE_LINE,
  UPGRADE_PRO_LABEL,
} from "@/shared/billing_copy";
import { triggerUpgrade } from "@/hooks/useUpgrade";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { useSettings } from "@/hooks/useSettings";
import { AtlarixAutoConsentDialog } from "@/components/AtlarixAutoConsentDialog";
import { UpgradeButtons } from "@/components/billing/UpgradeActions";

/** Open Settings → AI so the user can switch provider / model or add an API key. */
function openAiSettings() {
  openSettingsSection("ai");
}

// The markers are IMPORTED, not re-declared. They used to be typed out here as
// substrings of copy that lives elsewhere, so rewording that copy silently
// deleted the "Top up credit" button from the error that most needs it — nothing
// failed, nothing logged, the button was just gone.

/*
 * PALETTE: semantic tokens, plus alpha-over-surface for the accents. Fixed 2026-09-09.
 *
 * Every colour in this file used to be a literal light-mode palette class — `bg-sky-50`,
 * `bg-red-50`, `bg-blue-600` CTAs — with ZERO `dark:` variants, so in a dark app the
 * credit card rendered as the one white panel on screen, directly above a correctly
 * themed `bg-secondary` Retry button.
 *
 * Adding `dark:` variants would have been the wrong fix. The brand `--primary` is
 * emerald (`styles/globals.css`), so blue CTAs were off-palette in BOTH themes —
 * `dark:` would have faithfully preserved the wrong hue. Tokens for text and buttons,
 * and `<colour>-500/10` over the current surface for the two accent tints, which is the
 * convention the rest of the app already uses (see `InlinePermissionApprovals.tsx`,
 * `TokenBar.tsx`) and is theme-agnostic by construction rather than by duplication.
 */

export function ChatErrorBox({
  onDismiss,
  onRetry,
  error,
}: {
  onDismiss: () => void;
  /**
   * Re-run the failed turn. Given, the free-Auto consent card uses it: once the
   * user says yes, the message they already sent should simply go through —
   * making them send it again is a second ask for the same thing.
   */
  onRetry?: () => void;
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

  // Atlarix Auto's free share is used for today — the reset time is in the
  // message. Credit and your own key come first: people hit this in their
  // first days, before anyone starts a subscription. Pro stays, last.
  if (error.includes(FREE_LIMIT_MARKER)) {
    return (
      <ChatInfoContainer onDismiss={onDismiss}>
        <span>{error.replace(AI_STREAMING_ERROR_MESSAGE_PREFIX, "")}</span>
        <div className="mt-2 flex flex-wrap gap-2" data-testid="free-limit-actions">
          <TopUpButton>{ADD_CREDIT_LABEL}</TopUpButton>
          <SwitchProviderButton>{USE_OWN_KEY_LABEL}</SwitchProviderButton>
          <ProButton>{UPGRADE_PRO_LABEL}</ProButton>
        </div>
      </ChatInfoContainer>
    );
  }

  // Atlarix Auto with no credit, before the one-time OK for its free path.
  if (error.includes(AUTO_CONSENT_MARKER)) {
    return (
      <AutoConsentError error={error} onDismiss={onDismiss} onRetry={onRetry} />
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
        The model stopped responding mid-stream. Try sending your message again
        or switch to another model.
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
    "bg-primary text-primary-foreground hover:bg-primary/90 focus:ring-primary/50";
  const secondaryClasses =
    "bg-background text-foreground border border-border hover:bg-muted focus:ring-ring/50";
  const iconElement =
    icon ??
    (variant === "primary" ? (
      <CircleArrowUp size={18} />
    ) : (
      <ExternalLinkIcon size={14} />
    ));

  return (
    <a
      className={`${baseClasses} ${
        variant === "primary" ? primaryClasses : secondaryClasses
      }`}
      onClick={() => IpcClient.getInstance().openExternalUrl(href)}
    >
      <span>{children}</span>
      {iconElement}
    </a>
  );
}

/**
 * Free Auto needs the consent notice. Accepting records it and then RE-RUNS the
 * turn that was refused, so the user's message goes through without being sent
 * twice (reported 2026-09-25: "if allowed, it should continue the task").
 */
function AutoConsentError({
  error,
  onDismiss,
  onRetry,
}: {
  error: string;
  onDismiss: () => void;
  onRetry?: () => void;
}) {
  const { t } = useTranslation("chat");
  const { updateSettings } = useSettings();
  const [open, setOpen] = useState(false);
  const text = error
    .replace(AI_STREAMING_ERROR_MESSAGE_PREFIX, "")
    .replace(UPGRADE_LINE, "")
    .trim();
  return (
    <ChatInfoContainer onDismiss={onDismiss}>
      <AtlarixAutoConsentDialog
        open={open}
        onAccept={() => {
          setOpen(false);
          // The retry must follow the WRITE: main reads the consent from
          // settings when it builds the request header.
          void updateSettings({
            atlarixAutoConsentAt: new Date().toISOString(),
          }).then(() => (onRetry ? onRetry() : onDismiss()));
        }}
        onCancel={() => setOpen(false)}
      />
      <span>{text}</span>
      <p className="mt-1 text-muted-foreground">{UPGRADE_LINE}</p>
      <div className="mt-2 flex flex-wrap gap-2">
        <button
          type="button"
          data-testid="auto-review-consent"
          className="inline-flex cursor-pointer items-center rounded-md border border-border px-3 py-1.5 text-sm font-medium hover:bg-muted"
          onClick={() => setOpen(true)}
        >
          {t("atlarixAuto.reviewConsent")}
        </button>
        <UpgradeButtons />
      </div>
    </ChatInfoContainer>
  );
}

/** Opens Settings → AI where the Atlarix Core credit balance + top-up live. */
function TopUpButton({ children }: { children: React.ReactNode }) {
  const baseClasses =
    "cursor-pointer inline-flex items-center gap-1.5 rounded-md px-3 py-1.5 text-sm font-medium shadow-sm focus:outline-none focus:ring-2";
  const primaryClasses =
    "bg-primary text-primary-foreground hover:bg-primary/90 focus:ring-primary/50";
  return (
    <a className={`${baseClasses} ${primaryClasses}`} onClick={openAiSettings}>
      <span>{children}</span>
      <CircleArrowUp size={14} />
    </a>
  );
}

/** Starts the Pro upgrade; quiet, for walls where Pro is the last of the ways out. */
function ProButton({ children }: { children: React.ReactNode }) {
  return (
    <button
      type="button"
      data-testid="upgrade-to-pro"
      className="cursor-pointer inline-flex items-center gap-1.5 rounded-md px-3 py-1.5 text-sm font-medium text-muted-foreground hover:text-foreground hover:bg-muted focus:outline-none focus:ring-2 focus:ring-ring/50"
      onClick={() => void triggerUpgrade()}
    >
      {children}
    </button>
  );
}

/** Opens Settings → AI so the user can switch provider / model (BYOK) or add a key. */
function SwitchProviderButton({ children }: { children: React.ReactNode }) {
  const baseClasses =
    "cursor-pointer inline-flex items-center gap-1.5 rounded-md px-3 py-1.5 text-sm font-medium shadow-sm focus:outline-none focus:ring-2";
  const secondaryClasses =
    "bg-background text-foreground border border-border hover:bg-muted focus:ring-ring/50";
  return (
    <a
      className={`${baseClasses} ${secondaryClasses}`}
      onClick={openAiSettings}
    >
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
    <div className="relative mt-2 bg-destructive/10 border border-destructive/40 rounded-md shadow-sm p-2 mx-4">
      <button
        onClick={onDismiss}
        className="absolute top-2.5 left-2 p-1 hover:bg-destructive/20 rounded"
      >
        <X size={14} className="text-destructive" />
      </button>
      <div className="pl-8 py-1 text-sm">
        <div className="text-foreground text-wrap">
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
                    className="text-primary underline hover:no-underline"
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
    <div className="relative mt-2 bg-sky-500/10 border border-sky-500/40 rounded-md shadow-sm p-2 mx-4">
      <button
        onClick={onDismiss}
        className="absolute top-2.5 left-2 p-1 hover:bg-sky-500/20 rounded"
      >
        <X size={14} className="text-sky-600 dark:text-sky-400" />
      </button>
      <div className="pl-8 py-1 text-sm">
        <div className="text-foreground text-wrap">{children}</div>
      </div>
    </div>
  );
}
