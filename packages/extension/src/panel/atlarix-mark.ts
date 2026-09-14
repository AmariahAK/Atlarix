/**
 * The Atlarix mark in the panel header: a formed A at rest, the compass while
 * the agent works.
 *
 * ══ WHY THIS IS A PORT AND NOT AN IMPORT ══
 *
 * The desktop's `src/components/atlarix/AtlarixAnimation.tsx` is the original
 * and stays the source of truth for how the mark LOOKS. It cannot be imported:
 * it is a React component, and this package ships zero dependencies on purpose.
 * What crosses over is the geometry — the ring, the needle and the A — copied
 * so the two products draw the same shape rather than two drawings that
 * resemble each other.
 *
 * ONLY THE `bare` PATH CAME. The desktop's `bare` mode is documented as
 * "transparent bg, compass ring + needle + A only (no grid/labels/nodes)", and
 * at 20px in a header everything else is invisible anyway. The grid, crosshair,
 * degree readout, travelling nodes, pulse rings, split circle, wordmark and
 * status line are all deliberately absent — roughly 400 lines this panel would
 * render into four pixels.
 *
 * ══ IT STOPS WHEN IT IS DONE, AND THAT IS THE POINT ══
 *
 * At rest there is no `requestAnimationFrame` loop at all: the A is drawn once
 * and the callback is dropped, exactly as the desktop's bare branch does it. A
 * side panel sits open all day beside whatever the user is really doing, and a
 * permanent 60fps canvas in the corner of it is a battery cost with no
 * information in it. `working(false)` draws the final frame and stops.
 */

/** The desktop's dark palette, the only one a panel this dark needs. */
const C = {
  green: "#1a7a45",
  teal: "#2db87a",
  mint: "#c8ecd4",
  gold: "#f0a800",
  goldLight: "#ffd166",
  dim: "#1a3a28",
} as const;

const TWO_PI = Math.PI * 2;

const clamp = (v: number, lo: number, hi: number) =>
  Math.max(lo, Math.min(hi, v));
const easeOut = (t: number) => 1 - Math.pow(1 - clamp(t, 0, 1), 3);
const easeInOut = (t: number) => {
  t = clamp(t, 0, 1);
  return t < 0.5 ? 2 * t * t : -1 + (4 - 2 * t) * t;
};
const easeOutBack = (t: number, s = 1.8) => {
  t = clamp(t, 0, 1);
  return 1 + (s + 1) * Math.pow(t - 1, 3) + s * Math.pow(t - 1, 2);
};
/** The needle's overshoot as it settles on north. */
const compassSettle = (t: number) => {
  t = clamp(t, 0, 1);
  return t + 0.12 * Math.exp(-6 * t) * Math.cos(TWO_PI * 2.5 * t) * (1 - t);
};

/** Where the desktop's timeline holds once the A has formed. */
const HOLD_LT = 0.78;

function drawCompassRing(
  ctx: CanvasRenderingContext2D,
  cx: number,
  cy: number,
  R: number,
  alpha: number,
) {
  if (alpha <= 0) return;
  ctx.save();
  ctx.globalAlpha = alpha;
  ctx.beginPath();
  ctx.arc(cx, cy, R, 0, TWO_PI);
  ctx.strokeStyle = C.teal;
  ctx.lineWidth = 1.2;
  ctx.shadowColor = C.teal;
  ctx.shadowBlur = 8;
  ctx.stroke();
  ctx.beginPath();
  ctx.arc(cx, cy, R * 0.15, 0, TWO_PI);
  ctx.strokeStyle = C.dim;
  ctx.lineWidth = 1;
  ctx.shadowBlur = 0;
  ctx.stroke();
  // 36 ticks at 200px; at 20px they merge into a grey ring and cost 36 strokes
  // a frame to do it. Majors only, which is what actually reads at this size.
  for (let i = 0; i < 12; i++) {
    const a = (i / 12) * TWO_PI;
    const major = i % 3 === 0;
    const r0 = R * (major ? 0.78 : 0.88);
    ctx.beginPath();
    ctx.moveTo(cx + Math.cos(a) * r0, cy + Math.sin(a) * r0);
    ctx.lineTo(cx + Math.cos(a) * R * 0.97, cy + Math.sin(a) * R * 0.97);
    ctx.strokeStyle = major ? C.teal : C.dim;
    ctx.lineWidth = major ? 1.2 : 0.7;
    ctx.globalAlpha = alpha * (major ? 1 : 0.5);
    ctx.stroke();
  }
  ctx.restore();
}

function drawNeedle(
  ctx: CanvasRenderingContext2D,
  cx: number,
  cy: number,
  R: number,
  angle: number,
  alpha: number,
) {
  if (alpha <= 0) return;
  ctx.save();
  ctx.globalAlpha = alpha;
  ctx.translate(cx, cy);
  ctx.rotate(angle);
  const len = R * 0.75;
  const half = R * 0.08;
  ctx.beginPath();
  ctx.moveTo(0, -len);
  ctx.lineTo(-half, 0);
  ctx.lineTo(0, -len * 0.1);
  ctx.lineTo(half, 0);
  ctx.closePath();
  ctx.fillStyle = C.teal;
  ctx.shadowColor = C.teal;
  ctx.shadowBlur = 10;
  ctx.fill();
  ctx.beginPath();
  ctx.moveTo(0, len * 0.65);
  ctx.lineTo(-half, 0);
  ctx.lineTo(0, len * 0.08);
  ctx.lineTo(half, 0);
  ctx.closePath();
  ctx.fillStyle = C.gold;
  ctx.shadowColor = C.gold;
  ctx.shadowBlur = 8;
  ctx.fill();
  ctx.beginPath();
  ctx.arc(0, 0, Math.max(1.2, R * 0.06), 0, TWO_PI);
  ctx.fillStyle = C.mint;
  ctx.fill();
  ctx.restore();
}

/**
 * The A. Two strokes that splay out of a point as `morphProgress` goes 0 → 1,
 * a crossbar past halfway and the gold slash past 0.65 — the desktop's shape,
 * value for value.
 */
function drawLogoA(
  ctx: CanvasRenderingContext2D,
  cx: number,
  cy: number,
  size: number,
  alpha: number,
  morphProgress: number,
  t: number,
) {
  if (alpha <= 0) return;
  ctx.save();
  ctx.globalAlpha = alpha;
  const ht = size * 0.95;
  const hb = size * 0.65;
  const hw = size * 0.52;
  const mp = clamp(morphProgress, 0, 1);

  ctx.beginPath();
  ctx.moveTo(cx, cy - ht);
  ctx.lineTo(cx - hw * mp, cy + hb);
  ctx.lineTo(cx - hw * 0.52 * mp, cy + hb);
  ctx.lineTo(cx, cy - ht * 0.2);
  ctx.closePath();
  ctx.fillStyle = C.teal;
  ctx.shadowColor = C.teal;
  ctx.shadowBlur = 10 * mp + 3;
  ctx.fill();

  ctx.beginPath();
  ctx.moveTo(cx, cy - ht);
  ctx.lineTo(cx + hw * mp, cy + hb);
  ctx.lineTo(cx + hw * 0.52 * mp, cy + hb);
  ctx.lineTo(cx, cy - ht * 0.2);
  ctx.closePath();
  ctx.fillStyle = C.green;
  ctx.shadowColor = C.green;
  ctx.shadowBlur = 7 * mp + 2;
  ctx.fill();

  if (mp > 0.5) {
    ctx.save();
    ctx.globalAlpha = alpha * clamp((mp - 0.5) / 0.5, 0, 1);
    ctx.beginPath();
    ctx.moveTo(cx - hw * 0.52 * mp, cy + ht * 0.06);
    ctx.lineTo(cx + hw * 0.45 * mp, cy + ht * 0.06);
    ctx.lineTo(cx + hw * 0.45 * mp, cy + ht * 0.22);
    ctx.lineTo(cx - hw * 0.52 * mp, cy + ht * 0.22);
    ctx.closePath();
    ctx.fillStyle = C.mint;
    ctx.shadowColor = C.mint;
    ctx.shadowBlur = 5;
    ctx.fill();
    ctx.restore();
  }

  if (mp > 0.65) {
    // `t` is 0 when at rest, which freezes the pulse — that is what lets the
    // done state be ONE frame rather than a loop that only looks still.
    const pulse = 1 + Math.sin(t * 2.8) * 0.035;
    ctx.save();
    ctx.globalAlpha = alpha * clamp((mp - 0.65) / 0.35, 0, 1) * 0.95;
    ctx.translate(cx, cy);
    ctx.rotate(-0.2);
    ctx.scale(pulse, pulse);
    ctx.translate(-cx, -cy);
    ctx.beginPath();
    ctx.moveTo(cx - hw * 0.08, cy - ht * 0.88);
    ctx.lineTo(cx + hw * 0.58 * mp, cy + hb * 0.92);
    ctx.lineTo(cx + hw * 0.32 * mp, cy + hb * 0.92);
    ctx.lineTo(cx - hw * 0.34, cy - ht * 0.88);
    ctx.closePath();
    ctx.fillStyle = C.gold;
    ctx.shadowColor = C.goldLight;
    ctx.shadowBlur = 12;
    ctx.fill();
    ctx.restore();
  }
  ctx.restore();
}

export interface AtlarixMark {
  /** True while the agent is working. Idempotent; safe to call every render. */
  working(on: boolean): void;
  /** Drop the frame loop. For a panel teardown. */
  stop(): void;
}

/**
 * Mount the mark on a canvas.
 *
 * `prefers-reduced-motion` is honoured by never starting the loop — the mark
 * still switches to the compass so the state is legible, it simply does not
 * spin. A header that spins forever is exactly what that setting is for.
 */
export function mountAtlarixMark(canvas: HTMLCanvasElement): AtlarixMark {
  const ctx = canvas.getContext("2d");
  let raf: number | null = null;
  let busy = false;
  let start = 0;

  const reduced =
    typeof matchMedia === "function" &&
    matchMedia("(prefers-reduced-motion: reduce)").matches;

  const size = () => {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const w = canvas.offsetWidth || 20;
    const h = canvas.offsetHeight || 20;
    canvas.width = w * dpr;
    canvas.height = h * dpr;
    ctx?.setTransform(dpr, 0, 0, dpr, 0, 0);
    return { w, h };
  };

  const frame = (ts: number) => {
    // Clearing `raf` first matters: an early return that left it set would make
    // `render()` a permanent no-op, so a later `working(true)` would silently
    // draw nothing. jsdom is exactly this case — it has no 2D context.
    raf = null;
    if (!ctx) return;
    const { w, h } = size();
    const cx = w / 2;
    const cy = h / 2;
    const R = Math.min(w, h) * 0.46;
    const aR = Math.min(w, h) * 0.34;

    if (!busy) {
      // One frame, then nothing. `t = 0` freezes the slash pulse.
      ctx.clearRect(0, 0, w, h);
      drawLogoA(ctx, cx, cy, aR, 1, 1, 0);
      return;
    }

    if (!start) start = ts;
    const t = (ts - start) / 1000;
    // The desktop's "thinking" timeline: a 4s loop through the first half of
    // the intro, so the needle spins, settles, and the A begins to form.
    const lt = ((t % 4) / 4) * 0.5;

    const ringIn = easeOut(clamp(lt / 0.18, 0, 1));
    const ringAlpha = ringIn * (1 - easeInOut(clamp((lt - 0.32) / 0.12, 0, 1)));
    const needleAngle =
      lt < 0.32
        ? -Math.PI / 2 + (1 - compassSettle(lt / 0.32)) * 3.5 * TWO_PI
        : -Math.PI / 2;
    const needleAlpha =
      ringIn * (1 - easeInOut(clamp((lt - 0.42) / 0.12, 0, 1)));
    const morphP = easeOutBack(clamp((lt - 0.32) / 0.25, 0, 1));
    const aAlpha = easeOut(clamp((lt - 0.32) / 0.15, 0, 1));

    ctx.clearRect(0, 0, w, h);
    drawCompassRing(ctx, cx, cy, R, ringAlpha);
    drawNeedle(ctx, cx, cy, R, needleAngle, needleAlpha);
    drawLogoA(ctx, cx, cy, aR, aAlpha, morphP, t);
    raf = requestAnimationFrame(frame);
  };

  const render = () => {
    if (raf !== null) return;
    raf = requestAnimationFrame(frame);
  };

  render();

  return {
    working(on: boolean) {
      if (on === busy) return;
      busy = on;
      start = 0;
      if (on && reduced) {
        // Still legible, still still: one compass frame, no loop.
        if (!ctx) return;
        const { w, h } = size();
        ctx.clearRect(0, 0, w, h);
        drawCompassRing(ctx, w / 2, h / 2, Math.min(w, h) * 0.46, 1);
        drawNeedle(ctx, w / 2, h / 2, Math.min(w, h) * 0.46, -Math.PI / 2, 1);
        drawLogoA(ctx, w / 2, h / 2, Math.min(w, h) * 0.34, 1, HOLD_LT, 0);
        return;
      }
      render();
    },
    stop() {
      if (raf !== null) cancelAnimationFrame(raf);
      raf = null;
    },
  };
}
