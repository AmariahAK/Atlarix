/**
 * Rix, the Atlarix weaver ant, as SVG markup.
 *
 * ONE source for every surface that can draw SVG: the app, the Chrome side
 * panel, the VS Code webview, the site (which copies the exported files) and
 * the videos. A leaf module on purpose: no imports, so both extensions'
 * bundlers can take it.
 *
 * The body is a turning globe, one antenna is a compass needle. The state is a
 * class on the root, so a caller swaps it without redrawing:
 *   rest     settled, needle idling
 *   working  legs moving, needle spinning
 *   found    needle snaps and locks on
 *   loading  quick march
 *   scout    walking, carrying a message between sessions
 * Every motion stops under prefers-reduced-motion.
 */

export type RixState = "rest" | "working" | "found" | "loading" | "scout";

export const RIX_STATES: readonly RixState[] = ["rest", "working", "found", "loading", "scout"];

const GREEN = "#10b981";
const GREEN_SOFT = "#34d399";
const GREEN_DEEP = "#059669";
const BODY = "#141414";
const NEEDLE_TAIL = "#52525b";

/** Hip, knee, foot — a leg pivots at its hip. */
type Leg = [number, number, number, number, number, number];

const BACK_LEGS: Leg[] = [
  [155, 83, 173, 101, 185, 143],
  [143, 85, 149, 109, 143, 143],
  [131, 83, 111, 105, 99, 143],
];
const FRONT_LEGS: Leg[] = [
  [148, 86, 166, 104, 178, 146],
  [136, 88, 142, 112, 136, 146],
  [124, 86, 104, 108, 92, 146],
];

function leg([hx, hy, kx, ky, fx, fy]: Leg, i: number, front: boolean, joints: boolean): string {
  const tone = front ? GREEN : GREEN_DEEP;
  const outer = front ? 7 : 6;
  const inner = front ? 3.5 : 2.5;
  const d = `M ${hx} ${hy} L ${kx} ${ky} L ${fx} ${fy}`;
  // Alternate the phase so the six legs walk as two tripods.
  const phase = (i + (front ? 0 : 1)) % 2 === 0 ? "a" : "b";
  return (
    `<g class="rix-leg rix-leg-${phase}" style="transform-origin:${hx}px ${hy}px">` +
    `<path d="${d}" fill="none" stroke="${tone}" stroke-width="${outer}" stroke-linecap="round" stroke-linejoin="round"/>` +
    `<path d="${d}" fill="none" stroke="${BODY}" stroke-width="${inner}" stroke-linecap="round" stroke-linejoin="round"/>` +
    (joints
      ? `<circle cx="${hx}" cy="${hy}" r="3.2" fill="${BODY}" stroke="${tone}" stroke-width="1.6"/>` +
        `<circle cx="${kx}" cy="${ky}" r="3.6" fill="${BODY}" stroke="${tone}" stroke-width="1.8"/>`
      : "") +
    `<circle cx="${fx}" cy="${fy}" r="2.6" fill="${tone}"/>` +
    `</g>`
  );
}

function globe(id: string, turning: boolean): string {
  // The meridians widen and narrow out of step, which reads as a turning globe.
  const meridian = (from: string, dur: string) =>
    turning
      ? `<ellipse cx="62" cy="80" rx="${from.split(";")[0]}" ry="38"><animate attributeName="rx" values="${from}" dur="${dur}" repeatCount="indefinite"/></ellipse>`
      : `<ellipse cx="62" cy="80" rx="${from.split(";")[0]}" ry="38"/>`;
  return (
    `<circle cx="62" cy="80" r="38" fill="${GREEN}" fill-opacity="0.05" stroke="${GREEN}" stroke-width="3"/>` +
    `<g clip-path="url(#${id}-globe)" fill="none" stroke="${GREEN}" stroke-width="1.8" opacity="0.6">` +
    `<path d="M 26 70 Q 62 76 98 70"/><path d="M 26 90 Q 62 96 98 90"/>` +
    `<path d="M 24 80 Q 62 88 100 80"/><path d="M 30 62 Q 62 68 94 62"/><path d="M 30 98 Q 62 104 94 98"/>` +
    `<line x1="62" y1="42" x2="62" y2="118"/>` +
    meridian("34;4;34", "3.2s") +
    meridian("4;34;4", "3.2s") +
    meridian("18;30;4;18", "3.2s") +
    `</g>`
  );
}

const STYLE = (id: string) => `
#${id} .rix-body{transform-origin:120px 80px}
#${id} .rix-needle{transform-origin:198px 30px}
#${id}.working .rix-leg-a,#${id}.scout .rix-leg-a{animation:${id}-swing .75s ease-in-out infinite}
#${id}.working .rix-leg-b,#${id}.scout .rix-leg-b{animation:${id}-swing .75s ease-in-out -.375s infinite}
#${id}.loading .rix-leg-a{animation:${id}-swing .36s ease-in-out infinite}
#${id}.loading .rix-leg-b{animation:${id}-swing .36s ease-in-out -.18s infinite}
#${id}.working .rix-body,#${id}.scout .rix-body{animation:${id}-bob .375s ease-in-out infinite}
#${id}.loading .rix-body{animation:${id}-bob .18s ease-in-out infinite}
#${id}.rest .rix-body{transform:translateY(3px)}
#${id}.rest .rix-needle{animation:${id}-idle 2.4s ease-in-out infinite}
#${id}.working .rix-needle,#${id}.loading .rix-needle{animation:${id}-spin 1.2s linear infinite}
#${id}.scout .rix-needle{animation:${id}-idle 1.2s ease-in-out infinite}
#${id}.found .rix-needle{animation:${id}-lock .6s cubic-bezier(.2,1.6,.4,1) both}
#${id}.found .rix-body{animation:${id}-hop .5s ease-out both}
#${id}.found .rix-pupil{fill:#6ee7b7}
@keyframes ${id}-swing{0%,100%{transform:rotate(-10deg)}50%{transform:rotate(10deg)}}
@keyframes ${id}-bob{0%,100%{transform:translateY(0)}50%{transform:translateY(-2px)}}
@keyframes ${id}-idle{0%,100%{transform:rotate(-9deg)}50%{transform:rotate(9deg)}}
@keyframes ${id}-spin{to{transform:rotate(360deg)}}
@keyframes ${id}-lock{0%{transform:rotate(-140deg)}100%{transform:rotate(0)}}
@keyframes ${id}-hop{0%{transform:translateY(0)}40%{transform:translateY(-6px)}100%{transform:translateY(0)}}
@media (prefers-reduced-motion:reduce){#${id} *{animation:none!important}}
`;

let counter = 0;

export interface RixOptions {
  state?: RixState;
  /** CSS size; the drawing keeps its 200:136 shape. */
  size?: string;
  /** Accessible name. Empty string marks it decorative. */
  label?: string;
  /** "full" has joints and a turning globe; "mid" drops both for 32–64px. */
  detail?: "full" | "mid";
  /** A stable id (exports); otherwise one is minted so two Rixes never share keyframes. */
  id?: string;
}

/** Rix as an inline `<svg>` string. */
export function rixSvg(opts: RixOptions = {}): string {
  const state = opts.state ?? "rest";
  const detail = opts.detail ?? "full";
  const id = opts.id ?? `rix${++counter}`;
  const size = opts.size ?? "96px";
  const label = opts.label ?? "Rix, the Atlarix ant";
  const a11y = label ? `role="img" aria-label="${label}"` : `aria-hidden="true"`;
  const joints = detail === "full";
  return (
    `<svg id="${id}" class="rix ${state}" xmlns="http://www.w3.org/2000/svg" viewBox="20 14 200 136" width="${size}" style="width:${size};height:auto;overflow:visible" ${a11y}>` +
    `<defs><clipPath id="${id}-globe"><circle cx="62" cy="80" r="36"/></clipPath></defs>` +
    `<style>${STYLE(id)}</style>` +
    BACK_LEGS.map((l, i) => leg(l, i, false, joints)).join("") +
    `<g class="rix-body">` +
    `<path d="M 178 54 L 186 34 L 206 22" fill="none" stroke="${GREEN_DEEP}" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"/>` +
    `<path d="M 96 82 L 112 80" stroke="${GREEN}" stroke-width="5" stroke-linecap="round"/>` +
    `<circle cx="104" cy="81" r="7" fill="${BODY}" stroke="${GREEN}" stroke-width="3"/>` +
    globe(id, detail === "full") +
    `<g transform="rotate(-10 136 78)">` +
    `<ellipse cx="124" cy="80" rx="13" ry="11" fill="${BODY}" stroke="${GREEN}" stroke-width="3"/>` +
    `<ellipse cx="146" cy="76" rx="17" ry="13" fill="${BODY}" stroke="${GREEN}" stroke-width="3"/>` +
    `</g>` +
    `<path d="M 198 76 Q 214 80 212 88 Q 204 84 196 82" fill="#1a1a1a" stroke="${GREEN}" stroke-width="3" stroke-linejoin="round"/>` +
    `<ellipse cx="182" cy="68" rx="20" ry="17" fill="${BODY}" stroke="${GREEN}" stroke-width="3.5"/>` +
    `<circle cx="190" cy="65" r="8.5" fill="#0a0a0a" stroke="#2a2a2a" stroke-width="1"/>` +
    `<circle class="rix-pupil" cx="191" cy="65" r="4" fill="${GREEN_SOFT}"/>` +
    `<circle cx="189.5" cy="63.5" r="1.4" fill="#fafafa"/>` +
    `<path d="M 186 53 L 198 30" stroke="${GREEN}" stroke-width="6" stroke-linecap="round"/>` +
    `<path d="M 186 53 L 198 30" stroke="${BODY}" stroke-width="2.6" stroke-linecap="round"/>` +
    `<circle cx="190" cy="45.4" r="2.2" fill="${GREEN}"/><circle cx="193.9" cy="37.8" r="2.2" fill="${GREEN}"/>` +
    `<g class="rix-needle">` +
    `<polygon points="228,30 198,24 198,36" fill="${GREEN_SOFT}"/>` +
    `<polygon points="176,30 198,24 198,36" fill="${NEEDLE_TAIL}"/>` +
    `</g>` +
    `<circle cx="198" cy="30" r="5.5" fill="#1a1a1a" stroke="${GREEN}" stroke-width="3"/>` +
    `</g>` +
    FRONT_LEGS.map((l, i) => leg(l, i, true, joints)).join("") +
    `</svg>`
  );
}

/** Swap the state of a Rix already in the DOM, keeping its animation ids. */
export function setRixState(svg: Element | null, state: RixState): void {
  if (!svg) return;
  for (const s of RIX_STATES) svg.classList.remove(s);
  svg.classList.add(state);
}

/**
 * The 16×16 single-colour mark: ACP registry, VS Code activity bar, favicons.
 * Only `currentColor` and `none` — the registry rejects any literal colour.
 */
export const RIX_GLYPH_SVG =
  `<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round">` +
  `<circle cx="4.6" cy="8.6" r="3.4" stroke-width="1.3"/>` +
  `<path d="M4.6 5.2v6.8M1.4 8.6c2 .7 4.4.7 6.4 0" stroke-width="0.9"/>` +
  `<ellipse cx="9.6" cy="8.2" rx="1.6" ry="1.3" stroke-width="1.2"/>` +
  `<circle cx="12.6" cy="7" r="1.7" stroke-width="1.2"/>` +
  `<path d="M13.2 5.4l1.1-2.4M12.9 2.4h2.6" stroke-width="1.1"/>` +
  `<path d="M8.6 9.4l-1.4 3.6M9.8 9.6l.4 3.4M11 9.2l1.6 3.4" stroke-width="1"/>` +
  `</svg>`;
