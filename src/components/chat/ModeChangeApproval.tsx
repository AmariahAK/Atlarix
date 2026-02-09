/**
 * Dialog when the model requests a switch from Ask to Build. User can approve or deny.
 * Lucide icons only (MessageCircle, Hammer).
 */

import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { MessageCircle, Hammer } from "lucide-react";

export interface ModeChangeRequest {
  chatId: number;
  requestedMode: "ask" | "build";
  reason: string;
}

interface ModeChangeApprovalProps {
  open: boolean;
  request: ModeChangeRequest | null;
  onClose: () => void;
  onApprove: (chatId: number) => void;
  onDeny: (chatId: number) => void;
}

export function ModeChangeApproval({
  open,
  request,
  onClose,
  onApprove,
  onDeny,
}: ModeChangeApprovalProps) {
  if (!request) return null;

  const isRequestingBuild = request.requestedMode === "build";

  return (
    <AlertDialog open={open} onOpenChange={(o) => !o && onClose()}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle className="flex items-center gap-2">
            {isRequestingBuild ? (
              <Hammer className="h-5 w-5" />
            ) : (
              <MessageCircle className="h-5 w-5" />
            )}
            {isRequestingBuild
              ? "Switch to Build mode?"
              : "Switch to Ask mode?"}
          </AlertDialogTitle>
          <AlertDialogDescription>
            {request.reason ? (
              <span>{request.reason}</span>
            ) : (
              <span>
                {isRequestingBuild
                  ? "The AI wants to make code changes. Allow write/run tools?"
                  : "The AI wants to switch to read-only mode."}
              </span>
            )}
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel
            onClick={() => {
              onDeny(request.chatId);
              onClose();
            }}
          >
            {isRequestingBuild ? (
              <>
                <MessageCircle className="h-4 w-4 mr-1.5" />
                Stay in Ask
              </>
            ) : (
              <>
                <Hammer className="h-4 w-4 mr-1.5" />
                Stay in Build
              </>
            )}
          </AlertDialogCancel>
          <AlertDialogAction
            onClick={() => {
              onApprove(request.chatId);
              onClose();
            }}
          >
            {isRequestingBuild ? (
              <>
                <Hammer className="h-4 w-4 mr-1.5" />
                Switch to Build
              </>
            ) : (
              <>
                <MessageCircle className="h-4 w-4 mr-1.5" />
                Switch to Ask
              </>
            )}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
