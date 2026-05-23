import { useNavigate } from "@tanstack/react-router";
import { Button } from "@/components/ui/button";
import { triggerUpgrade } from "@/hooks/useUpgrade";

export function CompassExhaustedBanner({ tier }: { tier: string }) {
  const navigate = useNavigate();
  const t = tier.toLowerCase();

  return (
    <div className="rounded-md border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-sm text-foreground space-y-2">
      <p className="font-medium">Atlarix Core monthly limit reached</p>
      <p className="text-muted-foreground text-xs leading-relaxed">
        Add your own API keys in Settings to keep chatting, or upgrade for a higher Atlarix Core allowance.
      </p>
      <div className="flex flex-wrap gap-2">
        {t === "free" || t === "pro" ? (
          <Button size="sm" type="button" onClick={() => void triggerUpgrade()}>
            {t === "free" ? "Upgrade to Pro" : "Upgrade to Workforce"}
          </Button>
        ) : null}
        {t === "workforce" ? (
          <Button size="sm" variant="outline" type="button" asChild>
            <a href="mailto:support@atlarix.dev">Email support@atlarix.dev</a>
          </Button>
        ) : null}
        <Button
          size="sm"
          variant="secondary"
          type="button"
          onClick={() => navigate({ to: "/settings" })}
        >
          Open AI Settings
        </Button>
      </div>
    </div>
  );
}
