import { useAtomValue } from "jotai";
import {
  workspaceSessionLoadingAtom,
  workspaceSessionLoadingLabelAtom,
} from "@/atoms/sessionAtoms";
import AtlarixAnimation from "@/components/atlarix/AtlarixAnimation";

export function SessionLoadingOverlay() {
  const loading = useAtomValue(workspaceSessionLoadingAtom);
  const label = useAtomValue(workspaceSessionLoadingLabelAtom);

  if (!loading) return null;

  return (
    <div className="absolute inset-0 z-30 flex flex-col items-center justify-center bg-background/85 backdrop-blur-sm">
      <AtlarixAnimation size="md" />
      <p className="mt-4 text-sm text-muted-foreground">{label}</p>
    </div>
  );
}
