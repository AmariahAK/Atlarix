import { Clock, FolderOpen } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";

interface WorkspaceRecentsMenuProps {
  recentWorkspaces: string[];
  currentWorkspace?: string;
  onSelect: (path: string) => void;
  disabled?: boolean;
}

export function WorkspaceRecentsMenu({
  recentWorkspaces,
  currentWorkspace,
  onSelect,
  disabled,
}: WorkspaceRecentsMenuProps) {
  if (recentWorkspaces.length === 0) return null;

  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="h-6 w-6 p-0"
          title="Recent workspaces"
          disabled={disabled}
        >
          <Clock className="h-3.5 w-3.5" />
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-80 p-2">
        <p className="text-xs text-muted-foreground px-2 py-1 flex items-center gap-1.5">
          <Clock className="h-3.5 w-3.5 shrink-0" />
          Recent workspaces
        </p>
        <div className="max-h-48 overflow-y-auto space-y-0.5">
          {recentWorkspaces.map((path) => (
            <Button
              key={path}
              type="button"
              variant="ghost"
              className="w-full justify-start h-auto py-1.5 px-2 text-left font-normal"
              onClick={() => onSelect(path)}
            >
              <FolderOpen className="h-3.5 w-3.5 mr-2 shrink-0 text-muted-foreground" />
              <span className="truncate text-xs">{path}</span>
              {currentWorkspace === path ? (
                <span className="ml-auto text-[10px] text-primary shrink-0">active</span>
              ) : null}
            </Button>
          ))}
        </div>
      </PopoverContent>
    </Popover>
  );
}
