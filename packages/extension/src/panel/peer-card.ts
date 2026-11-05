import {
  PEER_FOLD_CHARS,
  peerPreview,
  peerRowLabel,
  type PeerSegment,
} from "@/lib/peers/peer-message";

/**
 * A TASK FROM ANOTHER SESSION IS NOT THE USER'S MESSAGE: its own row, with who
 * sent it. Open when short; a long one folds to ONE row that still carries its
 * text ("Message from X (CLI): <preview…>"), never a bare label (owner,
 * 2026-11-05: "a blank thing"). The same rows as the app, CLI and editor.
 */
export function peerTaskCard(segments: PeerSegment[]): HTMLElement {
  const wrap = document.createElement("div");
  wrap.className = "msg msg--peer";
  for (const seg of segments) {
    if (seg.kind !== "peer") {
      const extra = document.createElement("div");
      extra.className = "msg__prose";
      extra.textContent = seg.text;
      wrap.append(extra);
      continue;
    }
    const text = seg.text.trim();
    const details = document.createElement("details");
    details.className = "tool tool--peer";
    details.open = text.length <= PEER_FOLD_CHARS;
    const summary = document.createElement("summary");
    const dot = document.createElement("span");
    dot.className = "tool__dot";
    const label = document.createElement("span");
    label.className = "tool__label";
    label.textContent = peerRowLabel(seg.from, seg.surface);
    // Shown only while folded (sidepanel.css): open, the body says it all.
    const preview = document.createElement("span");
    preview.className = "tool__preview";
    preview.textContent = `: ${peerPreview(text).text}`;
    summary.append(dot, label, preview);
    const body = document.createElement("pre");
    body.className = "tool__body";
    body.textContent = text;
    details.append(summary, body);
    wrap.append(details);
  }
  return wrap;
}
