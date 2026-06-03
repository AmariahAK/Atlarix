/**
 * Custom Title Bar Component
 * ==========================
 * Draggable title bar with workspace, model, and user info (legacy /chat layout).
 */

import { useAtomValue } from "jotai";
import { currentAppAtom } from "@/atoms/appAtoms";
import { useUserBudgetInfo } from "@/hooks/useUserBudgetInfo";

export type TitleBarModelInfo = {
  name: string;
  status?: "connected" | "disconnected" | "error";
};

interface TitleBarProps {
  onMinimize?: () => void;
  onMaximize?: () => void;
  onClose?: () => void;
  currentModel?: TitleBarModelInfo | null;
}

export function TitleBar({
  onMinimize,
  onMaximize,
  onClose,
  currentModel = null,
}: TitleBarProps) {
  const currentApp = useAtomValue(currentAppAtom);
  const { userBudget } = useUserBudgetInfo();

  return (
    <div
      className="titlebar"
      style={{
        // @ts-ignore - Electron-specific
        WebkitAppRegion: "drag",
        height: "48px",
        background: "var(--obsidian-graphite)",
        borderBottom: "1px solid var(--graphite-border)",
        display: "flex",
        alignItems: "center",
        padding: "0 16px",
        justifyContent: "space-between",
        userSelect: "none",
      }}
    >
      <div style={{ display: "flex", gap: "12px", alignItems: "center" }}>
        <svg
          width="20"
          height="20"
          viewBox="0 0 24 24"
          fill="none"
          xmlns="http://www.w3.org/2000/svg"
        >
          <path
            d="M12 2L2 7L12 12L22 7L12 2Z"
            stroke="var(--teal-glow)"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
          <path
            d="M2 17L12 22L22 17"
            stroke="var(--teal-glow)"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
          <path
            d="M2 12L12 17L22 12"
            stroke="var(--teal-glow)"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>

        <span
          style={{
            color: "var(--primary-text)",
            fontWeight: 600,
            fontSize: "14px",
          }}
        >
          Atlarix
        </span>

        {currentApp && (
          <span
            style={{
              color: "var(--secondary-text)",
              fontSize: "13px",
              maxWidth: "300px",
              overflow: "hidden",
              textOverflow: "ellipsis",
              whiteSpace: "nowrap",
            }}
          >
            {currentApp.name || currentApp.path}
          </span>
        )}
      </div>

      <div
        style={{
          display: "flex",
          gap: "12px",
          alignItems: "center",
          // @ts-ignore
          WebkitAppRegion: "no-drag",
        }}
      >
        <ModelIndicator model={currentModel} />

        {userBudget?.redactedUserId ? (
          <UserAvatar label={userBudget.redactedUserId} />
        ) : null}

        <button
          className="titlebar-button"
          onClick={() => {
            /* settings */
          }}
          style={{
            background: "transparent",
            border: "none",
            cursor: "pointer",
            padding: "6px",
            borderRadius: "4px",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
          }}
        >
          <svg
            width="18"
            height="18"
            viewBox="0 0 24 24"
            fill="none"
            stroke="var(--secondary-text)"
            strokeWidth="2"
          >
            <circle cx="12" cy="12" r="3" />
            <path d="M12 1v6m0 6v6m8.66-15.66l-4.5 4.5m-4.5 4.5l-4.5 4.5M23 12h-6m-6 0H1m20.66 8.66l-4.5-4.5m-4.5-4.5l-4.5-4.5" />
          </svg>
        </button>

        <div style={{ display: "flex", gap: "8px", marginLeft: "8px" }}>
          <button onClick={onMinimize} className="window-control" type="button" style={windowBtnStyle}>
            −
          </button>
          <button onClick={onMaximize} className="window-control" type="button" style={windowBtnStyle}>
            ⬜
          </button>
          <button onClick={onClose} className="window-control close" type="button" style={windowBtnStyle}>
            ✕
          </button>
        </div>
      </div>
    </div>
  );
}

const windowBtnStyle: React.CSSProperties = {
  background: "transparent",
  border: "none",
  color: "var(--secondary-text)",
  cursor: "pointer",
  fontSize: "18px",
  width: "32px",
  height: "32px",
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  borderRadius: "4px",
};

function ModelIndicator({ model }: { model: TitleBarModelInfo | null }) {
  const isConnected = model?.status === "connected";

  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        gap: "6px",
        padding: "4px 8px",
        background: "var(--graphite-hover)",
        borderRadius: "6px",
        fontSize: "13px",
      }}
    >
      <div
        style={{
          width: "8px",
          height: "8px",
          borderRadius: "50%",
          background: isConnected ? "var(--teal-glow)" : "var(--secondary-text)",
          boxShadow: isConnected ? "0 0 8px var(--teal-glow)" : "none",
        }}
      />
      <span style={{ color: "var(--primary-text)", fontWeight: 500 }}>
        {model?.name || "No Model"}
      </span>
    </div>
  );
}

function UserAvatar({ label }: { label: string }) {
  return (
    <div
      style={{
        width: "32px",
        height: "32px",
        borderRadius: "50%",
        background: "var(--teal-glow)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        fontSize: "14px",
        fontWeight: 600,
        color: "var(--obsidian-graphite)",
        cursor: "pointer",
      }}
      title={label}
    >
      {label[0]?.toUpperCase() || "?"}
    </div>
  );
}
