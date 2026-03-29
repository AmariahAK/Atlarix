import { useNavigate } from "@tanstack/react-router";
import { Button } from "@/components/ui/button";

export function SignInToChatNotice() {
  const navigate = useNavigate();
  return (
    <div className="rounded-md border border-border bg-muted/30 px-3 py-2 text-sm text-muted-foreground flex flex-wrap items-center justify-between gap-2">
      <span>Sign in or create an account to use chat and AI.</span>
      <Button size="sm" type="button" onClick={() => navigate({ to: "/sign-in" })}>
        Sign in
      </Button>
    </div>
  );
}
