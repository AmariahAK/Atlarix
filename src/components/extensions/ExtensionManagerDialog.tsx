/**
 * Extension Manager — Lists available extensions, add to left panel. Tier-gated (Pro for DB Studio).
 */

import { useMemo } from "react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import {
  BUILTIN_EXTENSIONS,
  isExtensionAvailable,
  type Extension,
} from "@/lib/extensions/extension-registry";
import { useAuth } from "@/lib/auth/useAuth";
import { Database, Workflow, Github, MessageCircle, CheckSquare, ScrollText } from "lucide-react";
import { cn } from "@/lib/utils";

const ICON_MAP: Record<string, React.ComponentType<{ className?: string }>> = {
  Database,
  Workflow,
  Github,
  MessageCircle,
  CheckSquare,
  ScrollText,
};

interface ExtensionManagerDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  activeExtensionIds: string[];
  onAddToPanel: (extensionId: string) => void;
}

function ExtensionCard({
  ext,
  userTier,
  isActive,
  onAdd,
}: {
  ext: Extension;
  userTier: "free" | "pro";
  isActive: boolean;
  onAdd: () => void;
}) {
  const available = isExtensionAvailable(ext.id, userTier);
  const isWorkforce = ext.tier === "workforce";
  const Icon = ICON_MAP[ext.icon] ?? Database;

  return (
    <div
      className={cn(
        "flex items-start gap-3 rounded-lg border border-border p-3",
        isActive && "bg-sidebar-accent/30"
      )}
    >
      <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-md bg-muted">
        <Icon className="h-4 w-4 text-muted-foreground" />
      </div>
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span className="font-medium text-sm">{ext.name}</span>
          {isWorkforce && (
            <span className="rounded bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground">
              Workforce
            </span>
          )}
          {ext.tier === "pro" && !isWorkforce && (
            <span className="rounded bg-primary/20 px-1.5 py-0.5 text-[10px] text-primary">
              PRO
            </span>
          )}
        </div>
        <p className="mt-0.5 text-xs text-muted-foreground">{ext.description}</p>
        <div className="mt-2">
          {available ? (
            isActive ? (
              <span className="text-xs text-muted-foreground">Added to panel</span>
            ) : (
              <Button size="sm" variant="secondary" onClick={onAdd}>
                Add to Panel
              </Button>
            )
          ) : isWorkforce ? (
            <span className="text-xs text-muted-foreground">Coming in Workforce</span>
          ) : (
            <span className="text-xs text-muted-foreground">Upgrade to Pro</span>
          )}
        </div>
      </div>
    </div>
  );
}

export function ExtensionManagerDialog({
  open,
  onOpenChange,
  activeExtensionIds,
  onAddToPanel,
}: ExtensionManagerDialogProps) {
  const { status } = useAuth();
  const userTier: "free" | "pro" = status?.plan === "pro" ? "pro" : "free";

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md" showCloseButton>
        <DialogHeader>
          <DialogTitle>Extensions</DialogTitle>
          <DialogDescription>
            Add panels to the left sidebar. Pro unlocks DB Studio; more extensions in Workforce.
          </DialogDescription>
        </DialogHeader>
        <ScrollArea className="max-h-[60vh]">
          <div className="space-y-2 pr-2">
            {BUILTIN_EXTENSIONS.map((ext) => (
              <ExtensionCard
                key={ext.id}
                ext={ext}
                userTier={userTier}
                isActive={activeExtensionIds.includes(ext.id)}
                onAdd={() => onAddToPanel(ext.id)}
              />
            ))}
          </div>
        </ScrollArea>
      </DialogContent>
    </Dialog>
  );
}
