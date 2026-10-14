import { useRef, useState } from "react";
import { FileUp, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { IpcClient } from "@/ipc/ipc_client";
import { showError, showInfo } from "@/lib/toast";
import { useMcpAddFlow } from "./useMcpAddFlow";

/**
 * Add your own: paste a URL, a command line, or the `mcpServers` block from
 * Claude Desktop, Cursor, VS Code or Zed — or import that file. Where each
 * server lives is decided in main (src/lib/mcp/mcp-add.ts).
 */
export function McpPasteBox({ appId }: { appId: number }) {
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);
  const { finish, dialog } = useMcpAddFlow(appId);

  const add = async (input: string) => {
    if (!input.trim()) return;
    setBusy(true);
    try {
      const out = await IpcClient.getInstance().addPastedMcp({ appId, text: input });
      setText("");
      for (const f of out.failed) showError(`${f.name}: ${f.error}`);
      for (const s of out.skipped) showInfo(`Skipped ${s.name}: ${s.reason}.`);
      await finish(out.added);
    } catch (e) {
      showError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const onFile = async (file: File | undefined) => {
    if (!file) return;
    if (file.size > 1024 * 1024) {
      showError("That file is too large to be an MCP config.");
      return;
    }
    await add(await file.text());
    if (fileRef.current) fileRef.current.value = "";
  };

  return (
    <div className="space-y-2">
      <Textarea
        value={text}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) void add(text);
        }}
        rows={2}
        placeholder="Paste a URL, a command, or an mcpServers config"
        className="font-mono text-xs"
        disabled={busy}
      />
      <div className="flex items-center gap-2">
        <Button size="sm" onClick={() => void add(text)} disabled={busy || !text.trim()}>
          {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : "Add"}
        </Button>
        <Button size="sm" variant="outline" onClick={() => fileRef.current?.click()} disabled={busy}>
          <FileUp className="h-4 w-4 mr-1" />
          Import file
        </Button>
        <input
          ref={fileRef}
          type="file"
          accept=".json,.jsonc,application/json"
          className="hidden"
          onChange={(e) => void onFile(e.target.files?.[0])}
        />
      </div>
      {dialog}
    </div>
  );
}
