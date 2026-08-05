/**
 * Sign out — and, only if asked, remove this machine's local data.
 *
 * Until v14.27.0 signing out ALWAYS ran `db.delete(apps)`, wiping every
 * workspace along with its chat sessions, MCP servers, automations and the rest.
 * Now the destructive half is a separate, unchecked choice, and the default does
 * what the word means: it signs you out.
 *
 * Shared by both sign-out buttons (the sidebar account menu and Account
 * settings). The second one used to pass `signOut` straight to `onClick`, which
 * — once `signOut` took a parameter — would have handed it a MouseEvent and
 * deleted everything, every time. Routing both through one component is what
 * stops that from being possible.
 */
import { useState } from "react";
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
import { Checkbox } from "@/components/ui/checkbox";
import { useAuth } from "@/lib/auth/useAuth";

export function SignOutDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const { signOut } = useAuth();
  const [removeLocalData, setRemoveLocalData] = useState(false);

  return (
    <AlertDialog
      open={open}
      onOpenChange={(next) => {
        // Never carry the checkbox across openings — a destructive option must
        // be re-chosen every time, not remembered from a previous decision.
        if (!next) setRemoveLocalData(false);
        onOpenChange(next);
      }}
    >
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Sign out of Atlarix?</AlertDialogTitle>
          <AlertDialogDescription>
            Your workspaces, chats and settings stay on this computer. Sign back
            in and everything is where you left it.
          </AlertDialogDescription>
        </AlertDialogHeader>

        <label className="flex items-start gap-2.5 rounded-md border border-destructive/30 bg-destructive/5 p-3 text-sm cursor-pointer">
          <Checkbox
            checked={removeLocalData}
            onCheckedChange={(v) => setRemoveLocalData(v === true)}
            className="mt-0.5"
          />
          <span>
            <span className="block font-medium">
              Also remove my workspaces and chat history from this computer
            </span>
            <span className="block text-xs text-muted-foreground mt-0.5">
              Deletes every workspace, its chat sessions, MCP servers and
              automations. Your project folders and code are not touched. This
              cannot be undone.
            </span>
          </span>
        </label>

        <AlertDialogFooter>
          <AlertDialogCancel>Cancel</AlertDialogCancel>
          <AlertDialogAction
            onClick={() => {
              void signOut(removeLocalData);
              onOpenChange(false);
            }}
            className={
              removeLocalData
                ? "bg-destructive text-destructive-foreground hover:bg-destructive/90"
                : undefined
            }
          >
            {removeLocalData ? "Sign out and delete" : "Sign out"}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
