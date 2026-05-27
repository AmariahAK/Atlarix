import { useNavigate } from "@tanstack/react-router";
import { useAtomValue, useSetAtom } from "jotai";
import { ArrowLeft } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  selectedAppIdAtom,
  selectedWorkspaceInfoAtom,
} from "@/atoms/appAtoms";
import { activeChatIdAtom, selectedChatIdAtom } from "@/atoms/chatAtoms";
import { cn } from "@/lib/utils";

type SettingsWorkspaceNavProps = {
  className?: string;
};

/** Leave settings for the welcome picker or the active workspace. */
export function SettingsWorkspaceNav({ className }: SettingsWorkspaceNavProps) {
  const navigate = useNavigate();
  const selectedAppId = useAtomValue(selectedAppIdAtom);
  const workspaceInfo = useAtomValue(selectedWorkspaceInfoAtom);
  const setSelectedAppId = useSetAtom(selectedAppIdAtom);
  const setSelectedWorkspaceInfo = useSetAtom(selectedWorkspaceInfoAtom);
  const setActiveChatId = useSetAtom(activeChatIdAtom);
  const setSelectedChatId = useSetAtom(selectedChatIdAtom);

  const goToWorkspace = () => {
    navigate({ to: "/" });
  };

  const workspaceLabel = workspaceInfo?.name?.trim() || "workspace";
  const inWorkspace =
    selectedAppId != null ||
    Boolean(workspaceInfo?.path?.trim());

  return (
    <nav
      className={cn("flex flex-wrap items-center gap-2", className)}
      aria-label="Workspace navigation"
    >
      {inWorkspace ? (
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="gap-2 bg-(--background-lightest) py-5"
          onClick={goToWorkspace}
        >
          <ArrowLeft className="h-4 w-4 shrink-0" aria-hidden />
          Back to {workspaceLabel}
        </Button>
      ) : (
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="gap-2 bg-(--background-lightest) py-5"
          onClick={() => {
            setSelectedAppId(null);
            setSelectedWorkspaceInfo(null);
            setActiveChatId(null);
            setSelectedChatId(null);
            navigate({ to: "/" });
          }}
        >
          <ArrowLeft className="h-4 w-4 shrink-0" aria-hidden />
          Open or choose workspace
        </Button>
      )}
    </nav>
  );
}
