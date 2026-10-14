import { useState } from "react";
import { useAtomValue } from "jotai";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { useTranslation } from "react-i18next";
import { Loader2, Plug } from "lucide-react";
import { DropdownMenuLabel } from "@/components/ui/dropdown-menu";
import { Switch } from "@/components/ui/switch";
import { IpcClient } from "@/ipc/ipc_client";
import { selectedAppIdAtom } from "@/atoms/appAtoms";
import { showError } from "@/lib/toast";
import { McpServerIcon } from "@/components/settings/McpServerIcon";
import { useMcpAddFlow } from "@/components/settings/useMcpAddFlow";

/**
 * The Verified MCP servers in the composer's config menu (owner): each one's
 * logo, and a switch when it is added or Connect when it isn't — the same add
 * and sign-in as the marketplace, without leaving the chat.
 */
export function VerifiedMcpMenuSection() {
  const { t } = useTranslation("settings");
  const appId = useAtomValue(selectedAppIdAtom);
  const ipc = IpcClient.getInstance();
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const [busy, setBusy] = useState<string | null>(null);
  const { finish, dialog } = useMcpAddFlow(appId ?? 0);
  const { data } = useQuery({
    queryKey: ["mcp", "verified", appId ?? null],
    queryFn: () => ipc.getVerifiedMcpStatus(appId ?? null),
  });

  const refresh = () => void queryClient.invalidateQueries({ queryKey: ["mcp"] });

  const act = async (name: string, fn: () => Promise<unknown>) => {
    setBusy(name);
    try {
      await fn();
    } catch (e) {
      showError(String(e instanceof Error ? e.message : e).replace(/^.*Error:\s*/s, ""));
    } finally {
      setBusy(null);
      refresh();
    }
  };

  const connect = (s: NonNullable<typeof data>[number]) =>
    act(s.name, async () => {
      if (s.state === "not-added") {
        if (appId == null) throw new Error(t("mcp.openFolder"));
        const added = await ipc.installMcpFromCatalog({ appId, name: s.name, optionId: "remote:0" });
        await finish([added]);
      } else if (s.state === "needs-sign-in" && s.where === "account") {
        await ipc.signInAccountMcp({ id: String(s.id), appId });
      } else if (s.state === "needs-sign-in") {
        await ipc.startMcpOAuth({ serverId: Number(s.id) });
      } else {
        await finish([{ where: s.where!, id: s.id!, name: s.title, enabled: false, needsSignIn: false, needsSecret: { header: null } }]);
      }
    });

  const toggle = (s: NonNullable<typeof data>[number], on: boolean) =>
    act(s.name, () =>
      s.where === "account"
        ? ipc.setAccountMcpEnabled({ id: String(s.id), enabled: on, appId })
        : ipc.updateMcpServer({ id: Number(s.id), enabled: on }),
    );

  if (!data) return null;
  return (
    <>
      <DropdownMenuLabel className="flex items-center gap-2 text-xs font-medium text-muted-foreground">
        <Plug className="h-3.5 w-3.5" />
        {t("mcp.verifiedMenu")}
      </DropdownMenuLabel>
      {data.map((s) => (
        <div key={s.name} className="flex items-center gap-2 px-2 py-1">
          <McpServerIcon name={s.name} title={s.title} size={18} />
          <span className="flex-1 text-sm truncate">{s.title}</span>
          {busy === s.name ? (
            <Loader2 className="h-3.5 w-3.5 animate-spin text-muted-foreground" />
          ) : s.state === "on" || s.state === "off" ? (
            <Switch
              checked={s.state === "on"}
              onCheckedChange={(on) => void toggle(s, on)}
              aria-label={`${s.title} on`}
            />
          ) : (
            <button
              type="button"
              className="text-xs font-medium text-primary hover:underline"
              onClick={() => void connect(s)}
            >
              {s.state === "needs-key" ? t("mcp.addKey") : t("mcp.connect")}
            </button>
          )}
        </div>
      ))}
      <button
        type="button"
        className="w-full text-left px-2 pb-1 pt-0.5 text-[11px] text-muted-foreground hover:text-foreground"
        onClick={() => void navigate({ to: "/integrations/mcp" })}
      >
        {t("mcp.manage")}
      </button>
      {dialog}
    </>
  );
}
