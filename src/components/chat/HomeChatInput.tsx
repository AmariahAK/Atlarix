import { SendIcon, StopCircleIcon } from "lucide-react";

import { useSettings } from "@/hooks/useSettings";
import { homeChatInputValueAtom } from "@/atoms/chatAtoms"; // Use a different atom for home input
import { useAtom } from "jotai";
import { useStreamChat } from "@/hooks/useStreamChat";
import { useAttachments } from "@/hooks/useAttachments";
import { AttachmentsList } from "./AttachmentsList";
import { DragDropOverlay } from "./DragDropOverlay";
import { FileAttachmentDropdown } from "./FileAttachmentDropdown";
import { usePostHog } from "posthog-js/react";
import { HomeSubmitOptions } from "@/pages/home";
import { ChatInputControls } from "../ChatInputControls";
import { LexicalChatInput } from "./LexicalChatInput";
import { useChatModeToggle } from "@/hooks/useChatModeToggle";
import { useTypingPlaceholder } from "@/hooks/useTypingPlaceholder";
import { useCompassSendGate } from "@/hooks/useCompassSendGate";
import { CompassExhaustedBanner } from "./CompassExhaustedBanner";
import { CompassUsageStrip } from "./CompassUsageStrip";
import { formatCompassSubscriptionTier } from "@/shared/compass_product_copy";
import { useAuth } from "@/lib/auth/useAuth";
import { SignInToChatNotice } from "./SignInToChatNotice";

export function HomeChatInput({
  onSubmit,
}: {
  onSubmit: (options?: HomeSubmitOptions) => void;
}) {
  const posthog = usePostHog();
  const [inputValue, setInputValue] = useAtom(homeChatInputValueAtom);
  const { settings } = useSettings();
  const { isStreaming } = useStreamChat({
    hasChatId: false,
  }); // eslint-disable-line @typescript-eslint/no-unused-vars
  const {
    compassExhausted,
    usesCompass,
    tier,
    percentRemaining: compassPct,
    monthlyLimit: compassLimit,
    tokensUsedThisMonth: compassTokensUsed,
    loading: compassUsageLoading,
  } = useCompassSendGate();
  const { isAuthenticated, loading: authLoading } = useAuth();
  const mustSignIn = !authLoading && !isAuthenticated;
  useChatModeToggle();

  const typingText = useTypingPlaceholder([
    "an ecommerce store...",
    "an information page...",
    "a landing page...",
  ]);
  const placeholder = mustSignIn
    ? "Sign in to start chatting…"
    : `Ask Atlarix to build ${typingText ?? ""}`;

  // Use the attachments hook
  const {
    attachments,
    isDraggingOver,
    handleFileSelect,
    removeAttachment,
    handleDragOver,
    handleDragLeave,
    handleDrop,
    clearAttachments,
    handlePaste,
  } = useAttachments();

  // Custom submit function that wraps the provided onSubmit
  const handleCustomSubmit = () => {
    if ((!inputValue.trim() && attachments.length === 0) || isStreaming) {
      return;
    }
    if (mustSignIn) {
      import("@/lib/toast").then(({ showError }) => {
        showError("Please sign in to use chat.");
      });
      return;
    }
    if (compassExhausted) {
      import("@/lib/toast").then(({ showError }) => {
        showError("Compass monthly limit reached. Upgrade, add API keys in Settings, or pick another provider.");
      });
      return;
    }

    // REQUIREMENT: Must select model before sending (like StackSense/LM Studio)
    const hasModel = settings?.selectedModel ||
      ((settings?.providerSettings?.ollama as { models?: unknown[] } | undefined)?.models?.length ?? 0) > 0 ||
      ((settings?.providerSettings?.lmstudio as { models?: unknown[] } | undefined)?.models?.length ?? 0) > 0;

    if (!hasModel) {
      // Dynamically import to avoid circular deps
      import("@/lib/toast").then(({ showError }) => {
        showError("Please select a model first");
      });
      return;
    }

    // Call the parent's onSubmit handler with attachments
    onSubmit({ attachments });

    // Clear attachments as part of submission process
    clearAttachments();
    posthog.capture("chat:home_submit");
  };

  if (!settings) {
    return null; // Or loading state
  }

  return (
    <>
      <div className="p-4" data-testid="home-chat-input-container">
        <div
          className={`relative flex flex-col space-y-2 border border-border rounded-lg bg-(--background-lighter) shadow-sm ${isDraggingOver ? "ring-2 ring-blue-500 border-blue-500" : ""
            }`}
          onDragOver={handleDragOver}
          onDragLeave={handleDragLeave}
          onDrop={handleDrop}
        >
          {/* Attachments list */}
          <AttachmentsList
            attachments={attachments}
            onRemove={removeAttachment}
          />

          {/* Drag and drop overlay */}
          <DragDropOverlay isDraggingOver={isDraggingOver} />

          {mustSignIn ? (
            <div className="px-2 pt-1">
              <SignInToChatNotice />
            </div>
          ) : null}

          {usesCompass && compassLimit != null && compassLimit > 0 ? (
            <CompassUsageStrip
              subscriptionTierLabel={formatCompassSubscriptionTier(tier)}
              tokensUsedThisMonth={compassTokensUsed}
              monthlyLimit={compassLimit}
              percentRemaining={compassPct}
              loading={compassUsageLoading}
            />
          ) : null}
          {compassExhausted ? (
            <div className="px-2 pt-1">
              <CompassExhaustedBanner tier={tier} />
            </div>
          ) : null}

          <div className="flex items-start space-x-2 ">
            <LexicalChatInput
              value={inputValue}
              onChange={setInputValue}
              onSubmit={handleCustomSubmit}
              onPaste={handlePaste}
              placeholder={placeholder}
              disabled={isStreaming || compassExhausted || mustSignIn}
              excludeCurrentApp={false}
              disableSendButton={compassExhausted || mustSignIn}
            />

            {/* File attachment dropdown */}
            <FileAttachmentDropdown
              className="mt-1 mr-1"
              onFileSelect={handleFileSelect}
              disabled={isStreaming}
            />

            {isStreaming ? (
              <button
                className="px-2 py-2 mt-1 mr-2 text-(--sidebar-accent-fg) rounded-lg opacity-50 cursor-not-allowed" // Indicate disabled state
                title="Cancel generation (unavailable here)"
              >
                <StopCircleIcon size={20} />
              </button>
            ) : (
              <button
                onClick={handleCustomSubmit}
                disabled={
                  (!inputValue.trim() && attachments.length === 0) ||
                  compassExhausted ||
                  mustSignIn
                }
                className="px-2 py-2 mt-1 mr-2 hover:bg-(--background-darkest) text-(--sidebar-accent-fg) rounded-lg disabled:opacity-50"
                title="Send message"
              >
                <SendIcon size={20} />
              </button>
            )}
          </div>
          <div className="px-2 pb-2">
            <ChatInputControls />
          </div>
        </div>
      </div>
    </>
  );
}
