/**
 * CodePreviewPanel
 * ================
 * Right panel host for the workspace Terminal and Permissions tabs.
 *
 * The Console / Network tabs and the build-errors list were removed in
 * v14.52.0 with the in-app agent browser: the agent reads a page's console and
 * network in the user's own Chrome (`browser_inspect`), and dev-server output
 * lives in the terminal and its background jobs.
 */

import { InlinePermissionsHint } from "@/components/chat/InlinePermissionsHint";
import { type TerminalOutput } from "@/atoms/sourceAtoms";
import { TerminalPanel } from "@/components/panels/TerminalPanel";

interface CodePreviewPanelProps {
  data: {
    url?: string;
    terminal?: { output: string[]; running: boolean };
    terminalOutputs?: Map<string, TerminalOutput>;
    chatId?: number; // For permissions tab
    workspacePath?: string;
    appId?: number | null;
  } | null;
  activeTab: string;
}

function CodePreviewPanel({ activeTab }: CodePreviewPanelProps) {
  return (
    <div className="flex flex-col h-full">
      {activeTab === "terminal" && <TerminalPanel />}
      {activeTab === "permissions" && <PermissionsTab />}
    </div>
  );
}

function PermissionsTab() {
  return (
    <div className="flex flex-col h-full">
      <InlinePermissionsHint />
    </div>
  );
}

export default CodePreviewPanel;
