import { useSettings } from "@/hooks/useSettings";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";

import { showInfo } from "@/lib/toast";

export function AutoFixProblemsSwitch({
  showToast = false,
  showDescription = true,
}: {
  showToast?: boolean;
  /** When false, only the switch + label row (compact toolbars). */
  showDescription?: boolean;
}) {
  const { settings, updateSettings } = useSettings();
  const enabled = settings?.enableAutoFixProblems !== false;
  return (
    <div className="space-y-2">
      <div className="flex items-center space-x-2">
        <Switch
          id="auto-fix-after-build"
          checked={enabled}
          onCheckedChange={() => {
            updateSettings({
              enableAutoFixProblems: !enabled,
            });
            if (enabled && showToast) {
              showInfo("You can re-enable auto-fix under Settings → AI.");
            }
          }}
        />
        <Label htmlFor="auto-fix-after-build">Auto-fix errors after build</Label>
      </div>
      {showDescription ? (
        <p className="text-sm text-muted-foreground max-w-xl pl-1">
          After a build completes, automatically fix TypeScript errors and failed tests
          (max 2 attempts). Applies to build/agent turns only; Ask mode is unchanged.
        </p>
      ) : null}
    </div>
  );
}
