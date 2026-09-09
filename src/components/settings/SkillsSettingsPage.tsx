/**
 * Skills — a read view over `.atlarix/skills/*.md`.
 *
 * This page used to be a marketplace: a remote registry URL, a paginated browse tab with
 * tag and mode filters, install/uninstall buttons, and a panel for skills whose workspace
 * had gone away. All of that is deleted in v14.45, along with the `installed_skills` table
 * behind it.
 *
 * What replaces it is what users were actually doing anyway — writing a skill, or asking
 * the model to write one, at the moment they need it. So the page's job is now to show
 * what the workspace HAS and let you read it. Nothing here writes.
 *
 * There is no cap on the list. Repo skills were never capped (`skill-index.ts`: "Nothing
 * is capped and nothing is clipped"), and the cap that used to be displayed here only ever
 * governed marketplace installs, so it retired with them.
 */
import { useCallback, useEffect, useState } from "react";
import { useAtomValue } from "jotai";
import { FileText, Folder, Sparkles } from "lucide-react";
import { selectedAppIdAtom, selectedWorkspaceInfoAtom } from "@/atoms/appAtoms";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import { IpcClient } from "@/ipc/ipc_client";
import type { RepoSkillSummary } from "@/ipc/ipc_types";

function SkillRow({
  skill,
  expanded,
  body,
  loading,
  onToggle,
}: {
  skill: RepoSkillSummary;
  expanded: boolean;
  body: string | null;
  loading: boolean;
  onToggle: () => void;
}) {
  return (
    <div className="border rounded-lg">
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={expanded}
        className="w-full text-left px-4 py-3 flex items-start gap-3 hover:bg-muted/50 rounded-lg"
      >
        <FileText className="w-4 h-4 mt-0.5 text-muted-foreground shrink-0" />
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="font-medium truncate">{skill.name}</span>
            {skill.version ? (
              <Badge variant="outline" className="shrink-0">
                v{skill.version}
              </Badge>
            ) : null}
            {skill.modes.map((m) => (
              <Badge key={m} variant="secondary" className="shrink-0">
                {m}
              </Badge>
            ))}
          </div>
          {skill.description ? (
            <div className="text-sm text-muted-foreground mt-0.5">
              {skill.description}
            </div>
          ) : null}
          <div className="text-xs text-muted-foreground/80 mt-1 font-mono truncate">
            {skill.filename}
          </div>
        </div>
      </button>

      {expanded ? (
        <div className="px-4 pb-4">
          {loading ? (
            <div className="text-sm text-muted-foreground">Reading…</div>
          ) : body == null ? (
            <div className="text-sm text-muted-foreground">
              Could not read this file. It may have been moved or removed since
              the list was loaded.
            </div>
          ) : (
            <ScrollArea className="max-h-96 rounded border bg-muted/30">
              {/* Deliberately plain text, not rendered markdown: this is a view of
                  the FILE, and a skill's value is in its exact wording — including
                  the frontmatter and any literal markup the model will see. */}
              <pre className="p-3 text-xs whitespace-pre-wrap break-words font-mono">
                {body}
              </pre>
            </ScrollArea>
          )}
        </div>
      ) : null}
    </div>
  );
}

export function SkillsSettingsPage() {
  const ipc = IpcClient.getInstance();
  const selectedAppId = useAtomValue(selectedAppIdAtom);
  const workspaceInfo = useAtomValue(selectedWorkspaceInfoAtom);
  const workspacePath = workspaceInfo?.path ?? "";
  const workspaceName = workspaceInfo?.name ?? "Workspace";

  const [skills, setSkills] = useState<RepoSkillSummary[] | null>(null);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [bodies, setBodies] = useState<Record<string, string | null>>({});
  const [loadingBody, setLoadingBody] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    if (!selectedAppId) {
      setSkills(null);
      return;
    }
    try {
      const res = await ipc.listRepoSkills(selectedAppId);
      setSkills(res.skills);
    } catch (e) {
      console.warn(`Failed to load skills for workspace ${selectedAppId}:`, e);
      setSkills([]);
    }
  }, [ipc, selectedAppId]);

  useEffect(() => {
    // Re-read on every workspace change, and drop any body cached for the old one:
    // filenames are not unique across workspaces.
    setExpanded(null);
    setBodies({});
    void refresh();
  }, [refresh]);

  const onToggle = useCallback(
    async (skill: RepoSkillSummary) => {
      if (expanded === skill.filename) {
        setExpanded(null);
        return;
      }
      setExpanded(skill.filename);
      if (skill.filename in bodies) return; // already read once

      setLoadingBody(skill.filename);
      try {
        const res = await ipc.readRepoSkill(selectedAppId, skill.filename);
        setBodies((prev) => ({
          ...prev,
          [skill.filename]: res?.content ?? null,
        }));
      } catch (e) {
        console.warn(`Failed to read skill ${skill.filename}:`, e);
        setBodies((prev) => ({ ...prev, [skill.filename]: null }));
      } finally {
        setLoadingBody(null);
      }
    },
    [bodies, expanded, ipc, selectedAppId],
  );

  return (
    <div className="space-y-6">
      <div className="flex items-start gap-3">
        <Sparkles className="w-5 h-5 mt-0.5 text-muted-foreground shrink-0" />
        <div className="min-w-0">
          <h2 className="text-lg font-semibold">Skills</h2>
          <p className="text-sm text-muted-foreground">
            Markdown files in <code>.atlarix/skills/</code> that teach Atlarix a
            repeatable job. Atlarix sees their names and descriptions on every
            turn and reads the full file when one is relevant.
          </p>
        </div>
      </div>

      {!selectedAppId ? (
        <div className="text-sm text-muted-foreground">
          Select a workspace to see its skills.
        </div>
      ) : (
        <>
          <div className="flex items-center gap-3 min-w-0">
            <Folder className="w-4 h-4 text-muted-foreground shrink-0" />
            <div className="min-w-0 flex-1">
              <div className="font-medium truncate">{workspaceName}</div>
              <div className="text-xs text-muted-foreground truncate">
                {workspacePath}
              </div>
            </div>
            <Badge variant="outline" className="shrink-0">
              {skills?.length ?? 0}
            </Badge>
            <Button
              variant="outline"
              size="sm"
              onClick={() => {
                setBodies({});
                void refresh();
              }}
            >
              Refresh
            </Button>
          </div>

          {skills == null ? (
            <div className="text-sm text-muted-foreground">Loading…</div>
          ) : skills.length === 0 ? (
            <div className="text-sm text-muted-foreground border rounded-lg p-4">
              No skills in this workspace yet. Add a markdown file under{" "}
              <code>.atlarix/skills/</code> — or ask Atlarix to write one for
              you.
            </div>
          ) : (
            <div className="space-y-2">
              {skills.map((skill) => (
                <SkillRow
                  key={skill.filename}
                  skill={skill}
                  expanded={expanded === skill.filename}
                  body={bodies[skill.filename] ?? null}
                  loading={loadingBody === skill.filename}
                  onToggle={() => void onToggle(skill)}
                />
              ))}
            </div>
          )}
        </>
      )}
    </div>
  );
}
