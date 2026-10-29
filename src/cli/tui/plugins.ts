/**
 * /plugins — install, update, switch off and remove plugins, through the same
 * `plugins:*` handlers as the app's Settings → Plugins.
 *
 * Installing asks twice when the plugin can run anything: first what it is
 * (skills, agents, commands), then, IN FULL, every hook command, MCP server,
 * agent that runs tools and mod capability. "Not now" is first on both, so an
 * Enter typed for the composer is never a yes.
 */

import type {
  PluginListItem,
  PluginPreviewView,
} from "@/ipc/handlers/plugin_handlers";
import { InputDialog, ListDialog, type Line, type ListItem } from "./dialogs";
import type { ScreenContext } from "./screens";

const counts = (p: {
  skills: string[];
  agents: string[];
  commands: string[];
}): string =>
  [
    p.skills.length
      ? `${p.skills.length} skill${p.skills.length === 1 ? "" : "s"}`
      : "",
    p.agents.length
      ? `${p.agents.length} agent${p.agents.length === 1 ? "" : "s"}`
      : "",
    p.commands.length
      ? `${p.commands.length} command${p.commands.length === 1 ? "" : "s"}`
      : "",
  ]
    .filter(Boolean)
    .join(" · ") || "nothing to load";

function row(p: PluginListItem, workspaceDir: string): ListItem {
  const here =
    !p.folders ||
    p.folders.some(
      (f) => workspaceDir === f || workspaceDir.startsWith(`${f}/`),
    );
  return {
    id: p.name,
    label: p.name,
    detail: p.problem ?? `${counts(p)}${p.folders ? " · some folders" : ""}`,
    right: p.problem
      ? { text: "! check", tone: "warn" }
      : !p.enabled
        ? { text: "○ off", tone: "muted" }
        : here
          ? { text: "✓ on", tone: "accent" }
          : { text: "○ not here", tone: "muted" },
    keywords: p.enabled ? "on" : "off",
  };
}

export function openPlugins(ctx: ScreenContext): void {
  let plugins: PluginListItem[] = [];
  const dialog: ListDialog = new ListDialog({
    title: "Plugins",
    wide: true,
    empty: "No plugins yet. a adds one from GitHub or a folder.",
    hints: [
      { title: "On/off", key: "space" },
      { title: "Add", key: "a" },
      { title: "Update", key: "u" },
      { title: "Delete", key: "d" },
      { title: "More", key: "enter" },
    ],
    footer: "",
    items: async () => {
      plugins = await ctx.services.plugins.list();
      return plugins.map((p) => row(p, ctx.session.workspaceDir));
    },
    onChoose: (item) =>
      openPluginDetail(ctx, item.id, () => void dialog.reload()),
    actions: {
      " ": async (item) => {
        const p = plugins.find((x) => x.name === item.id);
        if (!p) return;
        await ctx.services.plugins.setEnabled(p.name, !p.enabled);
        await dialog.reload();
        return `${p.name} is ${p.enabled ? "off" : "on"}.`;
      },
      u: (item) => void startUpdate(ctx, item.id, () => void dialog.reload()),
      d: (item) => void confirmRemove(ctx, item.id, () => void dialog.reload()),
    },
    listActions: {
      a: () => void askSource(ctx, () => void dialog.reload()),
    },
  });
  ctx.host.push(dialog);
}

function askSource(ctx: ScreenContext, done: () => void): void {
  ctx.host.push(
    new InputDialog({
      title: "Add a plugin",
      label: "GitHub repository or folder",
      intro: [
        { text: "owner/repo, a github.com link, or a path", tone: "muted" },
      ],
      onSubmit: async (value) => {
        if (!value.trim()) return "Name a repository or a folder, or esc.";
        try {
          const preview = await ctx.services.plugins.prepare(
            value.trim(),
            ctx.session.workspaceDir,
          );
          ctx.host.pop();
          confirmInstall(ctx, preview, done);
        } catch (e) {
          return (e as Error).message;
        }
      },
    }),
  );
}

function startUpdate(ctx: ScreenContext, name: string, done: () => void): void {
  ctx.flash(`Checking ${name} for an update…`);
  ctx.services.plugins
    .prepareUpdate(name)
    .then((preview) => {
      if (preview.update && preview.update.changedFiles.length === 0) {
        void ctx.services.plugins.discard(preview.stagingId);
        return void ctx.flash(`${name} is up to date.`);
      }
      confirmInstall(ctx, preview, done);
    })
    .catch((e: Error) => ctx.flash(e.message, 6000, "warn"));
}

/** The first confirm: what the plugin is. */
export function previewLines(p: PluginPreviewView): Line[] {
  const lines: Line[] = [
    { text: `${p.name}${p.version ? ` ${p.version}` : ""}`, bold: true },
    {
      text: `${p.source}${p.sha ? ` @ ${p.sha.slice(0, 7)}` : ""}`,
      tone: "muted",
    },
  ];
  if (p.description) lines.push({ text: p.description, tone: "muted" });
  if (p.skills.length) lines.push({ text: `Skills: ${p.skills.join(", ")}` });
  if (p.agents.length) lines.push({ text: `Agents: ${p.agents.join(", ")}` });
  if (p.commands.length)
    lines.push({ text: `Commands: ${p.commands.join(", ")}` });
  if (p.update) {
    lines.push({
      text: `${p.update.changedFiles.length} file(s) changed`,
      tone: "muted",
    });
    for (const r of p.update.runnablesAdded)
      lines.push({ text: `+ ${r}`, tone: "warn" });
    for (const r of p.update.runnablesRemoved)
      lines.push({ text: `- ${r}`, tone: "muted" });
  }
  for (const u of p.unsupported)
    lines.push({ text: `Won't run: ${u}`, tone: "muted" });
  return lines;
}

function confirmInstall(
  ctx: ScreenContext,
  preview: PluginPreviewView,
  done: () => void,
): void {
  const verb = preview.update ? "Update" : "Install";
  const cancel = () => {
    void ctx.services.plugins.discard(preview.stagingId);
    ctx.host.pop();
  };
  const commit = async (runnablesConfirmed: boolean) => {
    try {
      await ctx.services.plugins.commit(preview.stagingId, runnablesConfirmed);
      ctx.host.closeAll();
      ctx.flash(
        `${preview.name} ${preview.update ? "updated" : "installed"}.`,
        4000,
        "success",
      );
      done();
    } catch (e) {
      ctx.host.closeAll();
      ctx.flash((e as Error).message, 6000, "error");
    }
  };
  ctx.host.push(
    new ListDialog({
      title: `${verb} ${preview.name}?`,
      intro: previewLines(preview),
      footer: "↑↓ move · enter choose · esc not now",
      items: [
        { id: "no", label: "Not now" },
        { id: "yes", label: preview.runnables.length ? "Continue" : verb },
      ],
      onChoose: async (item) => {
        if (item.id !== "yes") return cancel();
        if (!preview.runnables.length) return commit(false);
        ctx.host.push(
          new ListDialog({
            title: `${preview.name} runs code`,
            asking: true,
            intro: [
              {
                text: "Once on, it can run these on this computer:",
                bold: true,
              },
              ...preview.runnables.map((r) => ({ text: r })),
              {
                text: "Tool calls still ask you, as your own do.",
                tone: "muted" as const,
              },
            ],
            footer: "↑↓ move · enter choose · esc not now",
            items: [
              { id: "no", label: "Not now" },
              { id: "yes", label: `${verb} and allow these` },
            ],
            onChoose: async (second) => {
              if (second.id !== "yes") {
                void ctx.services.plugins.discard(preview.stagingId);
                return void ctx.host.closeAll();
              }
              await commit(true);
            },
          }),
        );
      },
    }),
  );
}

function confirmRemove(
  ctx: ScreenContext,
  name: string,
  done: () => void,
): void {
  ctx.host.push(
    new ListDialog({
      title: `Remove ${name}?`,
      footer: "↑↓ move · enter choose · esc not now",
      items: [
        { id: "no", label: "Not now" },
        { id: "yes", label: "Remove" },
      ],
      onChoose: async (item) => {
        ctx.host.pop();
        if (item.id !== "yes") return;
        await ctx.services.plugins.remove(name);
        ctx.flash(`${name} removed.`);
        done();
      },
    }),
  );
}

function openPluginDetail(
  ctx: ScreenContext,
  name: string,
  done: () => void,
): void {
  const detail: ListDialog = new ListDialog({
    title: name,
    footer: "↑↓ move · enter choose · esc back",
    items: async () => {
      const p = (await ctx.services.plugins.list()).find(
        (x) => x.name === name,
      );
      if (!p) return [];
      const thisFolderOnly = !!p.folders;
      const items: ListItem[] = [];
      if (p.problem?.includes("needs your OK again"))
        items.push({ id: "review", label: "Review what it runs" });
      items.push(
        { id: "toggle", label: p.enabled ? "Turn off" : "Turn on" },
        {
          id: "scope",
          label: thisFolderOnly ? "On in every folder" : "Only in this folder",
          detail: thisFolderOnly ? (p.folders ?? []).join(", ") : undefined,
        },
      );
      if (p.agents.length) {
        items.push({
          id: "model",
          label: "Model for its agents",
          detail: p.model ?? "the plugin's own, else the chat's",
        });
      }
      items.push(
        { id: "update", label: "Update" },
        { id: "remove", label: "Remove" },
      );
      return items;
    },
    onChoose: async (item) => {
      const p = (await ctx.services.plugins.list()).find(
        (x) => x.name === name,
      );
      if (!p) return;
      const refresh = async (say: string) => {
        await detail.reload();
        detail.say(say);
        done();
      };
      switch (item.id) {
        case "review":
          return reviewRunnables(
            ctx,
            name,
            () => void refresh(`${name} is on again.`),
          );
        case "toggle":
          await ctx.services.plugins.setEnabled(name, !p.enabled);
          return refresh(`${name} is ${p.enabled ? "off" : "on"}.`);
        case "scope":
          await ctx.services.plugins.setFolders(
            name,
            p.folders ? null : [ctx.session.workspaceDir],
          );
          return refresh(
            p.folders ? "On in every folder." : "Only in this folder.",
          );
        case "model":
          return ctx.host.push(
            new InputDialog({
              title: `Model for ${name}'s agents`,
              label:
                "provider/model (empty: the plugin's own, else the chat's)",
              initial: p.model ?? "",
              onSubmit: async (v) => {
                await ctx.services.plugins.setModel(name, v.trim() || null);
                ctx.host.pop();
                await refresh(
                  v.trim()
                    ? `${name}'s agents use ${v.trim()}.`
                    : "Back to the default model.",
                );
              },
            }),
          );
        case "update":
          return startUpdate(ctx, name, done);
        case "remove":
          return confirmRemove(ctx, name, () => {
            ctx.host.pop();
            done();
          });
      }
    },
  });
  ctx.host.push(detail);
}

function reviewRunnables(
  ctx: ScreenContext,
  name: string,
  done: () => void,
): void {
  ctx.services.plugins
    .review(name)
    .then((shown) =>
      ctx.host.push(
        new ListDialog({
          title: `${name} runs code`,
          asking: true,
          intro: [
            {
              text: "This version of Atlarix reads more of it than when you installed it. Once on, it can run:",
              bold: true,
            },
            ...shown.map((r) => ({ text: r })),
          ],
          footer: "↑↓ move · enter choose · esc not now",
          items: [
            { id: "no", label: "Not now" },
            { id: "yes", label: "Allow these" },
          ],
          onChoose: async (item) => {
            ctx.host.pop();
            if (item.id !== "yes") return;
            await ctx.services.plugins.approve(name, shown);
            done();
          },
        }),
      ),
    )
    .catch((e: Error) => ctx.flash(e.message, 6000, "warn"));
}
