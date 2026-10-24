/** @jsxImportSource @opentui/react */
/**
 * The first screen when nobody is signed in: Rix, a welcome, and the ways in,
 * as Claude Code and Codex open (owner, 2026-10-17: a bare "Sign in to start.
 * Opening your browser…" line that opened a browser by itself "would seem like
 * a bug"). The same choices as the app, the editors and the VS Code panel
 * (cli/auth/sign-in-choices.ts). The sign-in itself is the same as `atlarix
 * login`; this is only how it is offered. Pure, so a test can drive it
 * (tests-bun/cli-login.test.tsx).
 */
import { useKeyboard } from "@opentui/react";
import { useRef, useState } from "react";
import type { Line } from "./dialogs";
import { Rix } from "./Rix";
import { color } from "./theme";
import { linkify } from "./links";
import { SIGN_IN_CHOICES, type SignInChoice } from "../auth/sign-in-choices";

export type SignInMethod = SignInChoice;

const TONE: Record<string, string> = {
  accent: color.accent,
  muted: color.muted,
  warn: color.warn,
  error: color.error,
  text: color.text,
  heading: color.heading,
};

export function LoginScreen({
  version,
  preferCode = false,
  signIn,
  onSignedIn,
  onQuit,
}: {
  version: string;
  /** No display to open a browser on (SSH): the code comes first. */
  preferCode?: boolean;
  signIn: (method: SignInMethod, show: (lines: Line[]) => void) => Promise<string>;
  onSignedIn: (email: string) => void;
  onQuit: () => void;
}) {
  // No display to open a browser on: the code first, then the rest as they are.
  const order = preferCode
    ? [...SIGN_IN_CHOICES.filter((m) => m.id === "code"), ...SIGN_IN_CHOICES.filter((m) => m.id !== "code")]
    : SIGN_IN_CHOICES;
  const [selected, setSelected] = useState(0);
  const [lines, setLines] = useState<Line[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  // A sign-in can't be cancelled, only left: one still waiting that finishes
  // after esc still signs you in (signed in is signed in).
  const done = useRef(false);

  const start = (method: SignInMethod) => {
    setError(null);
    setLines([{ text: method === "code" ? "Getting a code…" : "Opening your browser…", tone: "muted" }]);
    signIn(method, (l) => {
      if (!done.current) setLines(l);
    }).then(
      (email) => {
        if (done.current) return;
        done.current = true;
        setLines([{ text: `✓ Signed in as ${email}`, tone: "accent", bold: true }]);
        setTimeout(() => onSignedIn(email), 700);
      },
      (e: unknown) => {
        if (done.current) return;
        setLines(null);
        setError(e instanceof Error ? e.message : String(e));
      },
    );
  };

  useKeyboard((key) => {
    if (key.ctrl && key.name === "c") return onQuit();
    if (done.current) return;
    if (lines) {
      // Waiting on the browser or the code: esc goes back to the choices.
      if (key.name === "escape") setLines(null);
      return;
    }
    if (key.name === "escape") return onQuit();
    if (key.name === "up") setSelected((i) => Math.max(0, i - 1));
    else if (key.name === "down") setSelected((i) => Math.min(order.length - 1, i + 1));
    else if (/^[1-9]$/.test(key.name) && Number(key.name) <= order.length) start(order[Number(key.name) - 1]!.id);
    else if (key.name === "return") start(order[selected]!.id);
  });

  return (
    <box flexDirection="column" height="100%" justifyContent="center" alignItems="center" backgroundColor={color.bg}>
      <box flexDirection="column" alignItems="center" gap={1} width={72}>
        <Rix mood="rest" />
        <text>
          <span fg={color.white}>
            <b>Welcome to Atlarix</b>
          </span>
          <span fg={color.faint}>{`  v${version}`}</span>
        </text>
        <text fg={color.textDim}>Sign in to start.</text>
        <box border borderStyle="rounded" borderColor={color.border} padding={1} flexDirection="column" width="100%">
          {lines ? (
            <box flexDirection="column">
              {lines.map((l, i) => (
                <text key={i} fg={TONE[l.tone ?? "text"] ?? color.text}>
                  {l.bold ? <b>{l.text}</b> : linkify(l.text)}
                </text>
              ))}
            </box>
          ) : (
            <box flexDirection="column">
              {order.map((m, i) => (
                <box key={m.id} flexDirection="column">
                  <text fg={i === selected ? color.white : color.textDim} bg={i === selected ? color.panel : undefined}>
                    <span fg={i === selected ? color.accent : color.faint}>{i === selected ? "❯ " : "  "}{i + 1}.</span>{" "}
                    {i === selected ? <b>{m.label}</b> : m.label}
                  </text>
                  <text fg={color.faint}>{`     ${m.detail}`}</text>
                </box>
              ))}
            </box>
          )}
        </box>
        {error ? <text fg={color.error}>{error}</text> : null}
        <text fg={color.muted}>
          {lines ? "esc back · ctrl+c quit" : `↑↓ choose · enter sign in · 1-${order.length} pick · esc quit`}
        </text>
      </box>
    </box>
  );
}
