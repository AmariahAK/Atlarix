/**
 * Co-author — whether Atlarix is credited on commits it makes.
 *
 * ONE CONTROL, AND THAT IS THE POINT. This was called "GitHub" and held two
 * unrelated things: a commit trailer (git, not GitHub) and a row for managing a
 * stored GitHub API token. The token is gone — it existed only for the clone
 * dialog, which was a GitHub device flow and so could never reach GitLab,
 * Bitbucket, self-hosted or plain SSH. With it went the second GitHub credential
 * that people kept confusing with signing in *to Atlarix* via GitHub.
 *
 * Signing in with GitHub is untouched: that goes through Supabase, which holds
 * its own OAuth credentials server-side (`lib/auth/supabase-client.ts`).
 *
 * Cloning still works — the agent runs `git clone` through `run_command`, on any
 * host, with the user's own credentials (SSH keys, credential helper, `gh`,
 * `glab`). Atlarix never has to hold a token for it.
 */

import { useSettings } from "@/hooks/useSettings";

export function IntegrationsCoAuthorPage() {
  const { settings, updateSettings } = useSettings();

  return (
    <div className="bg-card rounded-xl shadow-sm p-6 border border-border">
      <h2 className="text-lg font-medium text-foreground mb-4">Co-author</h2>
      <div className="space-y-2">
        <div className="flex items-center gap-2">
          <input
            id="include-atlarix-co-author"
            type="checkbox"
            checked={settings?.includeAtlarixCoAuthor !== false}
            onChange={(e) =>
              updateSettings({ includeAtlarixCoAuthor: e.target.checked })
            }
            className="rounded border-border"
          />
          <label
            htmlFor="include-atlarix-co-author"
            className="text-sm text-foreground"
          >
            Include Atlarix as co-author in commits
          </label>
        </div>
        <p className="text-xs text-muted-foreground max-w-xl">
          When enabled, every commit made through Atlarix includes a
          Co-authored-by trailer for atlarix-agent. Commits are always authored
          by your own git config — Atlarix never passes <code>--author</code> or
          changes your identity.
        </p>
      </div>
    </div>
  );
}
