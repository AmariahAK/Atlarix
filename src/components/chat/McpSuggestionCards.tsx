import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { useNavigate } from "@tanstack/react-router";
import { useQueryClient } from "@tanstack/react-query";
import { BadgeCheck, Loader2, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { IpcClient, type McpSuggestionView } from "@/ipc/ipc_client";
import { McpServerIcon } from "@/components/settings/McpServerIcon";
import { showError, showSuccess } from "@/lib/toast";
import type { CatalogInput } from "@/shared/mcp-catalog";

/**
 * MCP servers the agent suggested for this chat, above the composer.
 *
 * The agent found a server the task needs (`mcp_servers` suggest); the user
 * connects it here — add, sign in or paste a key — without opening the
 * marketplace. When it works, main tells the agent (as its tool result if it
 * waited, otherwise by waking the chat).
 */
export function McpSuggestionCards({ chatId }: { chatId: number }) {
  const [items, setItems] = useState<McpSuggestionView[]>([]);

  useEffect(() => {
    const ipc = IpcClient.getInstance();
    let alive = true;
    void ipc.listMcpSuggestions(chatId).then((list) => alive && setItems(list));
    const off = ipc.onMcpSuggestion((ev) => {
      if (ev.chatId !== chatId) return;
      setItems((prev) =>
        ev.type === "added"
          ? [...prev.filter((x) => x.id !== ev.suggestion.id), ev.suggestion]
          : prev.filter((x) => x.id !== ev.suggestion.id),
      );
    });
    return () => {
      alive = false;
      off();
    };
  }, [chatId]);

  if (items.length === 0) return null;
  return (
    <div className="mb-2 space-y-2">
      {items.map((s) => (
        <SuggestionCard key={s.id} s={s} />
      ))}
    </div>
  );
}

function SuggestionCard({ s }: { s: McpSuggestionView }) {
  const { t } = useTranslation("chat");
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const ipc = IpcClient.getInstance();
  const [busy, setBusy] = useState(false);
  const [waitingSignIn, setWaitingSignIn] = useState(false);
  const [secretFor, setSecretFor] = useState<{ where: "local" | "account"; id: string | number } | null>(null);
  const [secret, setSecret] = useState("");
  const [values, setValues] = useState<Record<string, string>>({});

  const entry = s.entry ?? null;
  const option = entry?.options.find((o) => o.kind === "web" || o.supported);
  // Values are asked for only when the server still has to be added.
  const inputs: CatalogInput[] = !s.status && option ? option.inputs : [];
  const title = s.status?.name ?? entry?.title ?? s.title;

  const finish = useCallback(async () => {
    const r = await ipc.finishMcpSuggestion(s.id);
    void queryClient.invalidateQueries({ queryKey: ["mcp"] });
    if (r.connected) showSuccess(t("mcpSuggest.connected", { name: r.server ?? title }));
    return r.connected;
  }, [ipc, s.id, queryClient, t, title]);

  // A local server's browser sign-in lands as an event; the card finishes then.
  useEffect(() => {
    if (!waitingSignIn) return;
    const off = ipc.onMcpOAuthSuccess?.(() => void finish().then((ok) => ok && setWaitingSignIn(false)));
    return () => off?.();
  }, [waitingSignIn, ipc, finish]);

  const connect = async () => {
    setBusy(true);
    try {
      const added = await ipc.connectMcpSuggestion({ id: s.id, ...(option ? { optionId: option.id } : {}), values });
      if (added.needsSignIn) {
        if (added.where === "account") {
          const r = await ipc.signInAccountMcp({ id: String(added.id), appId: s.appId });
          if (!r.ok) {
            showError(r.error ?? t("mcpSuggest.signInFailed", { name: title }));
            return;
          }
          await finish();
        } else {
          setWaitingSignIn(true);
          await ipc.startMcpOAuth({ serverId: Number(added.id) });
        }
        return;
      }
      if (added.needsSecret) {
        setSecretFor({ where: added.where, id: added.id });
        return;
      }
      await finish();
    } catch (e) {
      showError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const saveSecret = async () => {
    if (!secretFor || !secret.trim()) return;
    setBusy(true);
    try {
      if (secretFor.where === "account") {
        await ipc.setAccountMcpSecret({ id: String(secretFor.id), secret: secret.trim(), appId: s.appId });
      } else {
        await ipc.updateMcpServer({ id: Number(secretFor.id), apiKey: secret.trim() });
      }
      setSecretFor(null);
      await finish();
    } catch (e) {
      showError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const missing = inputs.some((i) => i.required && !values[i.key]?.trim() && i.default === undefined);

  return (
    <div className="rounded-xl border border-border bg-card overflow-hidden">
      <div className="flex items-center justify-between px-3 py-1.5 border-b border-border text-xs text-muted-foreground">
        <span>{t("mcpSuggest.recommended")}</span>
        <div className="flex items-center gap-2">
          <button
            type="button"
            className="hover:text-foreground"
            onClick={() => void navigate({ to: "/integrations/mcp", search: { tab: "marketplace" } as never })}
          >
            {t("mcpSuggest.browseAll")}
          </button>
          <button
            type="button"
            aria-label={t("mcpSuggest.notNow")}
            className="hover:text-foreground"
            onClick={() => void ipc.dismissMcpSuggestion(s.id)}
          >
            <X className="h-3.5 w-3.5" />
          </button>
        </div>
      </div>
      <div className="flex items-start gap-3 p-3">
        <McpServerIcon name={entry?.name ?? s.server} title={title} size={36} />
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-1.5 min-w-0">
            <span className="font-medium truncate">{title}</span>
            {entry?.verified ? <BadgeCheck className="h-3.5 w-3.5 text-primary shrink-0" aria-label="Verified" /> : null}
            {entry && !entry.verified ? (
              <span className="text-[11px] font-mono text-muted-foreground truncate">{entry.publisher}</span>
            ) : null}
          </div>
          <p className="text-xs text-muted-foreground line-clamp-2">{s.reason || entry?.description}</p>
          {inputs.length > 0 && !secretFor ? (
            <div className="mt-2 space-y-1.5">
              {inputs.map((i) => (
                <Input
                  key={i.key}
                  type={i.secret ? "password" : "text"}
                  className="h-8 text-xs"
                  placeholder={i.required ? i.label : `${i.label} ${t("mcpSuggest.optional")}`}
                  value={values[i.key] ?? ""}
                  onChange={(e) => setValues({ ...values, [i.key]: e.target.value })}
                />
              ))}
            </div>
          ) : null}
          {secretFor ? (
            <Input
              type="password"
              autoFocus
              className="mt-2 h-8 text-xs"
              placeholder={t("mcpSuggest.key")}
              value={secret}
              onChange={(e) => setSecret(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && void saveSecret()}
            />
          ) : null}
        </div>
        <Button
          size="sm"
          className="shrink-0"
          disabled={busy || waitingSignIn || (secretFor ? !secret.trim() : missing)}
          onClick={() => void (secretFor ? saveSecret() : connect())}
        >
          {busy || waitingSignIn ? <Loader2 className="h-4 w-4 animate-spin" /> : secretFor ? t("mcpSuggest.save") : t("mcpSuggest.connect")}
        </Button>
      </div>
    </div>
  );
}
