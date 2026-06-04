import { useEffect, useRef, useState } from "react";
import {
  ATLARIX_ANIMATION_PALETTE_DARK,
  resolveAnimationPalette,
  type AnimationThemeMode,
  type AtlarixAnimationPalette,
} from "./atlarix-animation-palette";

const TWO_PI = Math.PI * 2;

function clamp(v: number, lo: number, hi: number) { return Math.max(lo, Math.min(hi, v)); }
function easeOut(t: number)  { t=clamp(t,0,1); return 1-Math.pow(1-t,3); }
function easeOut5(t: number) { t=clamp(t,0,1); return 1-Math.pow(1-t,5); }
function easeInOut(t: number){ t=clamp(t,0,1); return t<0.5?2*t*t:-1+(4-2*t)*t; }
function easeOutBack(t: number, s=1.8) {
  t=clamp(t,0,1);
  return 1+(s+1)*Math.pow(t-1,3)+s*Math.pow(t-1,2);
}
function compassSettle(t: number) {
  t=clamp(t,0,1);
  const overshoot = Math.exp(-6*t)*Math.cos(TWO_PI*2.5*t);
  return t + 0.12*overshoot*(1-t);
}

function travelLerp(t: number) { return easeOut5(t); }

const INTRO_HOLD_LT = 0.78;
/** Wall-clock duration for playOnce (A forms near the end of this window). */
const INTRO_PLAY_SECONDS = 5.5;

export interface AtlarixAnimationProps {
  /** Size of the animation container (not full screen by default). */
  size?: "inline" | "xs" | "sm" | "md" | "lg" | "full";
  /** When "thinking", show compass/needle phase; when "done", show formed A. */
  phase?: "thinking" | "done";
  /** Run the intro once and hold on the formed A (ignores looping). */
  playOnce?: boolean;
  /** Hide corner version labels (welcome / sign-in). */
  minimalChrome?: boolean;
  /** Bare in-chat indicator: transparent bg, compass ring + needle + A only (no grid/labels/nodes). */
  bare?: boolean;
  /** Match system light/dark or force a palette. */
  theme?: AnimationThemeMode;
  className?: string;
}

const SIZE_MAP = {
  inline: { width: 24, height: 24 },
  xs: { width: 56, height: 56 },
  sm: { width: 120, height: 120 },
  md: { width: 200, height: 200 },
  lg: { width: 320, height: 320 },
  full: { width: "100vw", height: "100vh" },
} as const;

export default function AtlarixAnimation({
  size = "md",
  phase,
  playOnce = false,
  minimalChrome = false,
  bare = false,
  theme = "auto",
  className,
}: AtlarixAnimationProps) {
  const [palette, setPalette] = useState(() => resolveAnimationPalette(theme));
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const rafRef    = useRef<number | null>(null);
  const sRef      = useRef<{ ready: boolean; W?: number; H?: number; cx?: number; cy?: number; R?: number; aR?: number }>({ ready: false });
  const phaseRef  = useRef(phase);
  const playOnceRef = useRef(playOnce);
  const bareRef   = useRef(bare);
  const playOnceStartRef = useRef<number | null>(null);
  const frozenLtRef = useRef<number | null>(null);
  phaseRef.current = phase;
  playOnceRef.current = playOnce;
  bareRef.current = bare;

  useEffect(() => {
    const syncPalette = () => setPalette(resolveAnimationPalette(theme));
    syncPalette();
    if (theme !== "auto" || typeof window === "undefined") return;

    const mq = window.matchMedia("(prefers-color-scheme: dark)");
    mq.addEventListener("change", syncPalette);

    const rootObserver = new MutationObserver(syncPalette);
    rootObserver.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ["class"],
    });

    return () => {
      mq.removeEventListener("change", syncPalette);
      rootObserver.disconnect();
    };
  }, [theme]);

  useEffect(() => {
    const canvas = canvasRef.current;
    const C: AtlarixAnimationPalette = palette;
    const isAppDark = palette.bg === ATLARIX_ANIMATION_PALETTE_DARK.bg;
    if (!canvas) return;
    const ctx    = canvas.getContext("2d");
    if (!ctx) return;
    const s      = sRef.current;

    function resize() {
      const dpr = window.devicePixelRatio || 1;
      const w   = canvas!.offsetWidth;
      const h   = canvas!.offsetHeight;
      canvas!.width  = w * dpr;
      canvas!.height = h * dpr;
      // Refactor: ThoughtsPanel — also used full-screen for loading; avoid scale accumulation on resize
      ctx!.setTransform(1, 0, 0, 1, 0, 0);
      ctx!.scale(dpr, dpr);
      init(w, h);
    }

    function init(W: number, H: number) {
      s.W=W; s.H=H; s.cx=W/2; s.cy=H/2;
      const base = Math.min(W,H);
      // Bare in-chat indicator: ring fills the tiny canvas (no surrounding chrome).
      s.R  = base * (bareRef.current ? 0.42 : 0.28);
      s.aR = base * (bareRef.current ? 0.34 : 0.20);
      s.ready = true;
    }

    function drawBg(ctx: CanvasRenderingContext2D, W: number, H: number) {
      const bg = ctx.createRadialGradient(W / 2, H / 2, 0, W / 2, H / 2, Math.max(W, H) * 0.72);
      bg.addColorStop(0, C.bgMid);
      bg.addColorStop(0.55, C.bg);
      bg.addColorStop(1, C.bg);
      ctx.fillStyle = bg;
      ctx.fillRect(0, 0, W, H);
    }

    function drawGrid(ctx: CanvasRenderingContext2D, W: number, H: number, alpha: number) {
      if(alpha<=0) return;
      ctx.save(); ctx.globalAlpha=alpha*0.1; ctx.strokeStyle=C.teal; ctx.lineWidth=0.4;
      const sp=38;
      for(let x=0;x<W;x+=sp){ctx.beginPath();ctx.moveTo(x,0);ctx.lineTo(x,H);ctx.stroke();}
      for(let y=0;y<H;y+=sp){ctx.beginPath();ctx.moveTo(0,y);ctx.lineTo(W,y);ctx.stroke();}
      ctx.restore();
    }

    function drawCrosshair(ctx: CanvasRenderingContext2D, cx: number, cy: number, R: number, alpha: number) {
      if(alpha<=0) return;
      ctx.save();
      ctx.globalAlpha = alpha * 0.35;
      ctx.strokeStyle = C.teal;
      ctx.lineWidth   = 0.8;
      ctx.setLineDash([4,10]);
      ctx.beginPath(); ctx.moveTo(cx-R*1.6,cy); ctx.lineTo(cx+R*1.6,cy); ctx.stroke();
      ctx.beginPath(); ctx.moveTo(cx,cy-R*1.6); ctx.lineTo(cx,cy+R*1.6); ctx.stroke();
      ctx.setLineDash([]);
      ctx.globalAlpha = alpha * 0.5;
      ctx.font = "600 9px 'Courier New',monospace";
      ctx.fillStyle = C.teal;
      ctx.textAlign = "center";
      const labels = [
        { x: cx,        y: cy-R*1.5-8, t: "N" },
        { x: cx,        y: cy+R*1.5+16,t: "S" },
        { x: cx+R*1.55+14,y: cy+4,    t: "E" },
        { x: cx-R*1.55-14,y: cy+4,    t: "W" },
      ];
      labels.forEach(l=>ctx.fillText(l.t,l.x,l.y));
      ctx.restore();
    }

    function drawCompassRing(ctx: CanvasRenderingContext2D, cx: number, cy: number, R: number, alpha: number) {
      if(alpha<=0) return;
      ctx.save();
      ctx.globalAlpha = alpha;
      ctx.beginPath(); ctx.arc(cx,cy,R,0,TWO_PI);
      ctx.strokeStyle=C.teal; ctx.lineWidth=1.2;
      ctx.shadowColor=C.teal; ctx.shadowBlur=12; ctx.stroke();
      ctx.beginPath(); ctx.arc(cx,cy,R*0.15,0,TWO_PI);
      ctx.strokeStyle=C.dim; ctx.lineWidth=1; ctx.shadowBlur=0; ctx.stroke();
      for(let i=0;i<36;i++){
        const a=i/36*TWO_PI;
        const isMajor=(i%9===0);
        const isMed  =(i%3===0);
        const r0=R*(isMajor?0.82:isMed?0.87:0.91);
        const r1=R*0.97;
        ctx.beginPath();
        ctx.moveTo(cx+Math.cos(a)*r0, cy+Math.sin(a)*r0);
        ctx.lineTo(cx+Math.cos(a)*r1, cy+Math.sin(a)*r1);
        ctx.strokeStyle = isMajor ? C.teal : (isMed ? C.dim : C.dim);
        ctx.lineWidth   = isMajor ? 1.5 : 0.7;
        ctx.globalAlpha = alpha * (isMajor ? 1 : 0.5);
        ctx.stroke();
      }
      ctx.restore();
    }

    function drawNeedle(ctx: CanvasRenderingContext2D, cx: number, cy: number, R: number, angle: number, alpha: number) {
      if(alpha<=0) return;
      ctx.save();
      ctx.globalAlpha = alpha;
      ctx.translate(cx, cy);
      ctx.rotate(angle);
      const len  = R * 0.75;
      const half = R * 0.08;
      ctx.beginPath();
      ctx.moveTo(0, -len);
      ctx.lineTo(-half, 0);
      ctx.lineTo(0, -len*0.1);
      ctx.lineTo(half, 0);
      ctx.closePath();
      ctx.fillStyle   = C.teal;
      ctx.shadowColor = C.teal;
      ctx.shadowBlur  = 18;
      ctx.fill();
      ctx.beginPath();
      ctx.moveTo(0, len*0.65);
      ctx.lineTo(-half, 0);
      ctx.lineTo(0, len*0.08);
      ctx.lineTo(half, 0);
      ctx.closePath();
      ctx.fillStyle   = C.gold;
      ctx.shadowColor = C.gold;
      ctx.shadowBlur  = 14;
      ctx.fill();
      ctx.beginPath(); ctx.arc(0,0,4,0,TWO_PI);
      ctx.fillStyle=C.mint; ctx.shadowColor=C.mint; ctx.shadowBlur=8; ctx.fill();
      ctx.restore();
    }

    function drawLogoA(ctx: CanvasRenderingContext2D, cx: number, cy: number, size: number, alpha: number, morphProgress: number, t: number) {
      if(alpha<=0) return;
      ctx.save();
      ctx.globalAlpha = alpha;
      const ht = size*0.95, hb=size*0.65, hw=size*0.52;
      const mp = clamp(morphProgress,0,1);
      const lx0=cx, ly0=cy-ht;
      const lx1=cx-hw*mp, ly1=cy+hb;
      const lx2=cx-hw*0.52*mp, ly2=cy+hb;
      const lx3=cx, ly3=cy-ht*0.2;
      ctx.beginPath();
      ctx.moveTo(lx0,ly0);
      ctx.lineTo(lx1,ly1);
      ctx.lineTo(lx2,ly2);
      ctx.lineTo(lx3,ly3);
      ctx.closePath();
      ctx.fillStyle=C.teal; ctx.shadowColor=C.teal; ctx.shadowBlur=20*mp+6; ctx.fill();
      const rx0=cx, ry0=cy-ht;
      const rx1=cx+hw*mp, ry1=cy+hb;
      const rx2=cx+hw*0.52*mp, ry2=cy+hb;
      const rx3=cx, ry3=cy-ht*0.2;
      ctx.beginPath();
      ctx.moveTo(rx0,ry0); ctx.lineTo(rx1,ry1); ctx.lineTo(rx2,ry2); ctx.lineTo(rx3,ry3);
      ctx.closePath();
      ctx.fillStyle=C.green; ctx.shadowColor=C.green; ctx.shadowBlur=14*mp+4; ctx.fill();
      if(mp > 0.5) {
        const cbAlpha = clamp((mp-0.5)/0.5,0,1);
        ctx.save();
        ctx.globalAlpha = alpha*cbAlpha;
        ctx.beginPath();
        ctx.moveTo(cx-hw*0.52*mp, cy+ht*0.06);
        ctx.lineTo(cx+hw*0.45*mp, cy+ht*0.06);
        ctx.lineTo(cx+hw*0.45*mp, cy+ht*0.22);
        ctx.lineTo(cx-hw*0.52*mp, cy+ht*0.22);
        ctx.closePath();
        ctx.fillStyle=C.mint; ctx.shadowColor=C.mint; ctx.shadowBlur=10; ctx.fill();
        ctx.restore();
      }
      if(mp > 0.65) {
        const slashP = clamp((mp-0.65)/0.35,0,1);
        const pulse  = 1+Math.sin(t*2.8)*0.035;
        ctx.save();
        ctx.globalAlpha = alpha * slashP * 0.95;
        ctx.translate(cx,cy); ctx.rotate(-0.20); ctx.scale(pulse,pulse); ctx.translate(-cx,-cy);
        ctx.beginPath();
        ctx.moveTo(cx-hw*0.08, cy-ht*0.88);
        ctx.lineTo(cx+hw*0.58*mp, cy+hb*0.92);
        ctx.lineTo(cx+hw*0.32*mp, cy+hb*0.92);
        ctx.lineTo(cx-hw*0.34, cy-ht*0.88);
        ctx.closePath();
        ctx.fillStyle=C.gold; ctx.shadowColor=C.goldLight; ctx.shadowBlur=24; ctx.fill();
        ctx.restore();
      }
      ctx.restore();
    }

    function drawSplitCircle(ctx: CanvasRenderingContext2D, cx: number, cy: number, R: number, alpha: number) {
      if(alpha<=0) return;
      ctx.save(); ctx.globalAlpha=alpha;
      ctx.beginPath(); ctx.moveTo(cx,cy-R); ctx.arc(cx,cy,R,-Math.PI/2,Math.PI/2); ctx.lineTo(cx,cy+R); ctx.closePath();
      ctx.fillStyle=C.greenDark; ctx.shadowColor=C.teal; ctx.shadowBlur=22*alpha; ctx.fill();
      ctx.beginPath(); ctx.moveTo(cx,cy-R); ctx.arc(cx,cy,R,Math.PI/2,-Math.PI/2); ctx.closePath();
      ctx.fillStyle=C.mintSoft; ctx.shadowBlur=0; ctx.fill();
      ctx.beginPath(); ctx.arc(cx,cy,R,0,TWO_PI);
      ctx.strokeStyle=C.teal; ctx.lineWidth=2; ctx.shadowColor=C.teal; ctx.shadowBlur=14*alpha; ctx.stroke();
      ctx.restore();
    }

    const NODE_DEFS = [
      { axis: "N", label: "NODE",      color: C.teal,     dest: { dx: 0,    dy: -1 } },
      { axis: "E", label: "BEACON",    color: C.gold,     dest: { dx:  1,   dy: 0  } },
      { axis: "S", label: "PACKET",    color: C.mint,     dest: { dx: 0,    dy:  1 } },
      { axis: "W", label: "CONTAINER", color: C.teal,     dest: { dx: -1,   dy: 0  } },
      { axis: "NE",label: "FLOW",      color: C.goldLight,dest: { dx: 0.7,  dy:-0.7} },
    ];

    function drawTravelingNodes(ctx: CanvasRenderingContext2D, cx: number, cy: number, R: number, progress: number, alpha: number) {
      if(alpha<=0) return;
      NODE_DEFS.forEach((n, i) => {
        const delay = i * 0.14;
        const t     = clamp((progress - delay) / 0.55, 0, 1);
        if(t <= 0) return;
        const ease  = travelLerp(t);
        const startDist = R * 1.55;
        const endDist   = R * 0.35;
        const dist      = startDist - (startDist - endDist) * ease;
        const px = cx + n.dest.dx * dist;
        const py = cy + n.dest.dy * dist;
        const arrived = t >= 0.92;
        const glow = arrived ? 1 : ease;
        if(!arrived) {
          ctx.save();
          ctx.globalAlpha = alpha * ease * 0.3;
          ctx.beginPath();
          ctx.moveTo(cx + n.dest.dx*startDist, cy + n.dest.dy*startDist);
          ctx.lineTo(px, py);
          ctx.strokeStyle = n.color;
          ctx.lineWidth   = 1;
          ctx.setLineDash([3,6]);
          ctx.stroke();
          ctx.setLineDash([]);
          ctx.restore();
        }
        const dotR = arrived ? 6 : 4 + ease*2;
        ctx.save();
        ctx.globalAlpha = alpha * (0.5 + glow*0.5);
        ctx.beginPath(); ctx.arc(px, py, dotR, 0, TWO_PI);
        ctx.fillStyle   = n.color;
        ctx.shadowColor = n.color;
        ctx.shadowBlur  = 16*glow;
        ctx.fill();
        if(arrived) {
          ctx.beginPath(); ctx.arc(px,py,dotR+4,0,TWO_PI);
          ctx.strokeStyle = n.color;
          ctx.lineWidth   = 1.2;
          ctx.globalAlpha = alpha*0.5;
          ctx.shadowBlur  = 10;
          ctx.stroke();
        }
        ctx.restore();
        const labelAlpha = clamp((t-0.6)/0.4,0,1);
        if(labelAlpha>0) {
          ctx.save();
          ctx.globalAlpha = alpha*labelAlpha;
          ctx.textAlign   = "center";
          const lx = cx + n.dest.dx*(endDist+28);
          const ly = cy + n.dest.dy*(endDist+28) + (n.dest.dy===0?-10:0);
          ctx.font      = "700 8px 'Courier New',monospace";
          ctx.fillStyle = n.color;
          ctx.shadowColor=n.color; ctx.shadowBlur=8;
          ctx.fillText(n.label, lx, ly);
          const coordX = Math.round(n.dest.dx*100);
          const coordY = Math.round(n.dest.dy*-100);
          ctx.font      = "400 7px 'Courier New',monospace";
          ctx.fillStyle = C.white;
          ctx.globalAlpha=alpha*labelAlpha*0.5;
          ctx.shadowBlur=0;
          ctx.fillText(`(${coordX}, ${coordY})`, lx, ly+11);
          ctx.restore();
        }
      });
    }

    function drawDegreeReadout(ctx: CanvasRenderingContext2D, cx: number, cy: number, R: number, angleDeg: number, alpha: number) {
      if(alpha<=0) return;
      ctx.save();
      ctx.globalAlpha = alpha;
      ctx.textAlign   = "center";
      ctx.font        = "700 10px 'Courier New',monospace";
      ctx.fillStyle   = C.teal;
      ctx.shadowColor = C.teal; ctx.shadowBlur = 8;
      const deg = ((angleDeg % 360) + 360) % 360;
      ctx.fillText(`${Math.round(deg)}°`, cx, cy + R + 28);
      ctx.restore();
    }

    function drawPulseRing(ctx: CanvasRenderingContext2D, cx: number, cy: number, R: number, ringT: number, gold: boolean) {
      const prog  = clamp(ringT,0,1);
      const r     = R*0.18 + prog*R*1.5;
      const alpha = (1-prog)*0.55;
      ctx.save();
      ctx.beginPath(); ctx.arc(cx,cy,r,0,TWO_PI);
      ctx.strokeStyle = gold ? C.gold : C.teal;
      ctx.lineWidth   = 1.8*(1-prog*0.85);
      ctx.globalAlpha = alpha;
      ctx.shadowColor = gold ? C.gold : C.teal; ctx.shadowBlur=18;
      ctx.stroke();
      ctx.restore();
    }

    function drawWordmark(ctx: CanvasRenderingContext2D, W: number, H: number, alpha: number) {
      if(alpha<=0) return;
      ctx.save(); ctx.textAlign="center";
      ctx.globalAlpha=alpha;
      ctx.font="300 26px Georgia,'Times New Roman',serif";
      ctx.fillStyle=C.white;
      ctx.shadowColor=C.teal;
      ctx.shadowBlur=isAppDark ? 16 * alpha : 4 * alpha;
      ctx.fillText("Atlarix",W/2,H-42);
      ctx.font="500 8px 'Courier New',monospace";
      ctx.fillStyle=C.teal; ctx.shadowBlur=isAppDark ? 6 : 0; ctx.globalAlpha=alpha*0.6;
      ctx.fillText("GRAPH INTELLIGENCE  ·  ARCHITECTURE FIRST",W/2,H-24);
      ctx.restore();
    }

    function drawStatus(ctx: CanvasRenderingContext2D, W: number, H: number, phaseLabel: number) {
      const labels: Record<number, string>={
        0:"● COMPASS ORIENTING",
        1:"● AXIS LOCKING",
        2:"● NODES CONVERGING",
        3:"● ATLARIX FORMED",
      };
      ctx.save();
      ctx.globalAlpha=0.45;
      ctx.font="500 8px 'Courier New',monospace";
      ctx.fillStyle=phaseLabel===3?C.gold:C.teal;
      ctx.textAlign="left";
      ctx.fillText(labels[phaseLabel]||"",18,H-18);
      ctx.restore();
    }

    const LOOP = 8.0;
    let pulseT1=-1, pulseT2=-1;

    function frame(ts: number) {
      if(!s.ready || !s.W || !s.H){ rafRef.current=requestAnimationFrame(frame); return; }
      const t   = ts/1000;
      const {W,H,cx,cy,R,aR}=s;
      const p = phaseRef.current;
      let lt: number;
      if (playOnceRef.current) {
        if (frozenLtRef.current != null) {
          lt = frozenLtRef.current;
        } else {
          if (playOnceStartRef.current == null) playOnceStartRef.current = ts;
          const elapsed = (ts - playOnceStartRef.current) / 1000;
          lt = Math.min(elapsed / INTRO_PLAY_SECONDS, INTRO_HOLD_LT);
          if (lt >= INTRO_HOLD_LT) {
            frozenLtRef.current = INTRO_HOLD_LT;
            lt = INTRO_HOLD_LT;
          }
        }
      } else if (p === "thinking") {
        lt = ((t % 4) / 4) * 0.5;
      } else if (p === "done") {
        lt = INTRO_HOLD_LT;
      } else {
        lt = (t % LOOP) / LOOP;
      }

      const ringFadeIn  = easeOut(clamp(lt/0.18,0,1));
      const ringFadeOut = easeInOut(clamp((lt-0.32)/0.12,0,1));
      const ringAlpha   = ringFadeIn*(1-ringFadeOut);

      let needleAngle: number;
      if(lt < 0.32) {
        const spinT = lt/0.32;
        const totalTurns = 3.5;
        const settled = compassSettle(spinT);
        needleAngle = -Math.PI/2 + (1-settled)*totalTurns*TWO_PI;
      } else {
        needleAngle = -Math.PI/2;
      }
      const needleAlpha = ringFadeIn*(1-easeInOut(clamp((lt-0.42)/0.12,0,1)));

      const morphP = easeOutBack(clamp((lt-0.32)/0.25,0,1));
      const aAlpha = easeOut(clamp((lt-0.32)/0.15,0,1))*(lt<0.88?1:1-easeInOut((lt-0.88)/0.12));

      const nodesP  = clamp((lt-0.52)/0.22,0,1);
      const nodesAlpha = easeOut(clamp((lt-0.52)/0.1,0,1))*(lt<0.88?1:1-easeInOut((lt-0.88)/0.12));

      const circleAlpha = easeOut(clamp((lt-0.70)/0.10,0,1))*(lt<0.88?1:1-easeInOut((lt-0.88)/0.12));

      if(lt>0.73&&lt<0.87) {
        if(pulseT1<0||(t%(LOOP))>LOOP*0.735&&pulseT1<t-2) pulseT1=t;
        if(pulseT2<0||(t%(LOOP))>LOOP*0.760&&pulseT2<t-2) pulseT2=t;
      } else if(lt<0.1) { pulseT1=-1; pulseT2=-1; }

      const degAlpha = ringAlpha;
      const angleDeg = (needleAngle+Math.PI/2)*180/Math.PI + 360;

      const wordAlpha = easeOut(clamp((lt-0.70)/0.10,0,1))*(lt<0.88?1:1-easeInOut((lt-0.88)/0.12));

      const phaseLabel = lt<0.32?0:lt<0.52?1:lt<0.72?2:3;

      ctx!.clearRect(0,0,W!,H!);
      if (bareRef.current) {
        // Bare in-chat indicator: compass ring + needle while thinking, formed A when done.
        if (p === "done") {
          // Stagnant A — draw once (t=0 freezes the slash pulse) and stop animating.
          drawLogoA(ctx!,cx!,cy!,aR!,1,1,0);
          rafRef.current = null;
          return;
        }
        drawCompassRing(ctx!,cx!,cy!,R!,ringAlpha);
        if(needleAlpha>0) drawNeedle(ctx!,cx!,cy!,R!,needleAngle,needleAlpha);
        if(aAlpha>0) drawLogoA(ctx!,cx!,cy!,aR!,aAlpha,morphP,t);
        rafRef.current=requestAnimationFrame(frame);
        return;
      }
      drawBg(ctx!,W!,H!);
      drawGrid(ctx!,W!,H!,0.8);

      drawCrosshair(ctx!,cx!,cy!,R!,ringAlpha);
      drawCompassRing(ctx!,cx!,cy!,R!,ringAlpha);
      drawDegreeReadout(ctx!,cx!,cy!,R!,angleDeg,degAlpha);

      if(needleAlpha>0) drawNeedle(ctx!,cx!,cy!,R!,needleAngle,needleAlpha);

      if(circleAlpha>0) drawSplitCircle(ctx!,cx!,cy!,aR!*0.9,circleAlpha);

      const now=t;
      if(pulseT1>0) drawPulseRing(ctx!,cx!,cy!,aR!,(now-pulseT1)/2.6,false);
      if(pulseT2>0) drawPulseRing(ctx!,cx!,cy!,aR!,(now-pulseT2)/2.6,true);

      if(nodesAlpha>0) drawTravelingNodes(ctx!,cx!,cy!,R!,nodesP,nodesAlpha);

      if(aAlpha>0) drawLogoA(ctx!,cx!,cy!,aR!,aAlpha,morphP,t);

      if(wordAlpha>0) drawWordmark(ctx!,W!,H!,wordAlpha);

      drawStatus(ctx!,W!,H!,phaseLabel);

      rafRef.current=requestAnimationFrame(frame);
    }

    resize();
    window.addEventListener("resize",resize);
    rafRef.current=requestAnimationFrame(frame);
    return ()=>{ window.removeEventListener("resize",resize); if (rafRef.current) cancelAnimationFrame(rafRef.current); };
  }, [phase, playOnce, palette]);

  const dims = SIZE_MAP[size];
  const isFull = size === "full";
  const containerStyle: React.CSSProperties = {
    width: typeof dims.width === "number" ? dims.width : dims.width,
    height: typeof dims.height === "number" ? dims.height : dims.height,
    background: bare ? "transparent" : palette.bg,
    overflow: "hidden",
    position: "relative",
    borderRadius: isFull ? 0 : 8,
  };

  return (
    <div style={containerStyle} className={className}>
      {!isFull && !minimalChrome && !bare && (
        <>
          <div style={{position:"absolute",top:8,left:10,fontSize:9,color:"#2db87a40",fontFamily:"'Courier New',monospace",letterSpacing:"2px"}}>Workspace Intelligence</div>
          <div style={{position:"absolute",top:8,right:10,fontSize:9,color:"#2db87a40",fontFamily:"'Courier New',monospace",letterSpacing:"2px"}}>v2.9.0 · AXIS</div>
        </>
      )}
      <canvas ref={canvasRef} style={{width:"100%",height:"100%",display:"block"}} />
    </div>
  );
}
