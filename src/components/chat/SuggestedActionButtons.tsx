/**
 * Suggested-action buttons rendered under assistant replies.
 * v10.1: extracted from the deleted legacy ChatInput.tsx (its only live export).
 */

import { useCallback } from "react";
import { useAtomValue } from "jotai";
import { usePostHog } from "posthog-js/react";
import { Button } from "@/components/ui/button";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { selectedAppIdAtom } from "@/atoms/appAtoms";
import { selectedChatIdAtom } from "@/atoms/chatAtoms";
import { useStreamChat } from "@/hooks/useStreamChat";
import { useRunApp } from "@/hooks/useRunApp";
import { useSummarizeInNewChat } from "./SummarizeInNewChatButton";
import type { SuggestedAction } from "@/lib/schemas";

function SuggestionButton({
  children,
  onClick,
  tooltipText,
}: {
  onClick: () => void;
  children: React.ReactNode;
  tooltipText: string;
}) {
  const { isStreaming } = useStreamChat();
  return (
    <TooltipProvider>
      <Tooltip>
        <TooltipTrigger asChild>
          <Button
            disabled={isStreaming}
            variant="outline"
            size="sm"
            onClick={onClick}
          >
            {children}
          </Button>
        </TooltipTrigger>
        <TooltipContent>{tooltipText}</TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}

function SummarizeInNewChatButton() {
  const { handleSummarize } = useSummarizeInNewChat();
  return (
    <SuggestionButton
      onClick={handleSummarize}
      tooltipText="Creating a new chat makes the AI more focused and efficient"
    >
      Summarize to new chat
    </SuggestionButton>
  );
}

function RefactorFileButton({ path }: { path: string }) {
  const chatId = useAtomValue(selectedChatIdAtom);
  const { streamMessage } = useStreamChat();
  const onClick = () => {
    if (!chatId) {
      console.error("No chat id found");
      return;
    }
    streamMessage({
      prompt: `Refactor ${path} and make it more modular`,
      chatId,
      redo: false,
    });
  };
  return (
    <SuggestionButton
      onClick={onClick}
      tooltipText="Refactor the file to improve maintainability"
    >
      <span className="max-w-[180px] overflow-hidden whitespace-nowrap text-ellipsis">
        Refactor {path.split("/").slice(-2).join("/")}
      </span>
    </SuggestionButton>
  );
}

function WriteCodeProperlyButton() {
  const chatId = useAtomValue(selectedChatIdAtom);
  const { streamMessage } = useStreamChat();
  const onClick = () => {
    if (!chatId) {
      console.error("No chat id found");
      return;
    }
    streamMessage({
      prompt: `Write the code in the previous message in the correct format using \`<atlarix-write>\` tags!`,
      chatId,
      redo: false,
    });
  };
  return (
    <SuggestionButton
      onClick={onClick}
      tooltipText="Write code properly (useful when AI generates the code in the wrong format)"
    >
      Write code properly
    </SuggestionButton>
  );
}

function RebuildButton() {
  const { restartApp } = useRunApp();
  const posthog = usePostHog();
  const selectedAppId = useAtomValue(selectedAppIdAtom);

  const onClick = useCallback(async () => {
    if (!selectedAppId) return;

    posthog.capture("action_rebuild");
    await restartApp({ removeNodeModules: true });
  }, [selectedAppId, posthog, restartApp]);

  return (
    <SuggestionButton onClick={onClick} tooltipText="Rebuild the application">
      Rebuild app
    </SuggestionButton>
  );
}

function RestartButton() {
  const { restartApp } = useRunApp();
  const posthog = usePostHog();
  const selectedAppId = useAtomValue(selectedAppIdAtom);

  const onClick = useCallback(async () => {
    if (!selectedAppId) return;

    posthog.capture("action_restart");
    await restartApp();
  }, [selectedAppId, posthog, restartApp]);

  return (
    <SuggestionButton
      onClick={onClick}
      tooltipText="Restart the development server"
    >
      Restart app
    </SuggestionButton>
  );
}

function KeepGoingButton() {
  const { streamMessage } = useStreamChat();
  const chatId = useAtomValue(selectedChatIdAtom);
  const onClick = () => {
    if (!chatId) {
      console.error("No chat id found");
      return;
    }
    streamMessage({
      prompt: "Keep going",
      chatId,
    });
  };
  return (
    <SuggestionButton onClick={onClick} tooltipText="Keep going">
      Keep going
    </SuggestionButton>
  );
}

export function mapActionToButton(action: SuggestedAction) {
  switch (action.id) {
    case "summarize-in-new-chat":
      return <SummarizeInNewChatButton />;
    case "refactor-file":
      return <RefactorFileButton path={action.path} />;
    case "write-code-properly":
      return <WriteCodeProperlyButton />;
    case "rebuild":
      return <RebuildButton />;
    case "restart":
      return <RestartButton />;
    case "keep-going":
      return <KeepGoingButton />;
    default:
      console.error(`Unsupported action: ${action.id}`);
      return (
        <Button variant="outline" size="sm" disabled key={action.id}>
          Unsupported: {action.id}
        </Button>
      );
  }
}
