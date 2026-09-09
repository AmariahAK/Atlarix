import { cn } from "@/lib/utils";

export interface TokenCircleProps {
  used: number;
  total: number;
  size?: number;
  /** Subtle pulse while context compaction / summarization is running */
  pulse?: boolean;
  /** Brief success accent after compaction completes */
  flashSuccess?: boolean;
  /**
   * A turn is streaming: spin a fixed arc instead of tracking the live value.
   *
   * WHY THIS MODE EXISTS. `used` comes from live provider usage, which updates many
   * times a second, and every update restarted the 0.3s `stroke-dashoffset`
   * transition below — so it never finished and the arc JUMPED instead of easing.
   * It read as a spinner that could not spin.
   *
   * The fix is not a faster transition, it is not animating a moving target at all:
   * while streaming, the arc is a constant length rotated by a CSS keyframe. A
   * transform animation runs on the compositor, so it stays smooth no matter how
   * often React re-renders — which is exactly the property the value-driven
   * transition could never have. The live number is still readable: the percentage
   * beside this circle keeps updating and is the authoritative reading.
   */
  spin?: boolean;
}

export function TokenCircle({
  used,
  total,
  size = 24,
  pulse = false,
  flashSuccess = false,
  spin = false,
}: TokenCircleProps) {
  const safeTotal = total > 0 ? total : 1;
  const pct = Math.min(Math.max(used / safeTotal, 0), 1);
  const radius = (size - 4) / 2;
  const circumference = 2 * Math.PI * radius;
  const offset = circumference * (1 - pct);

  const color = flashSuccess
    ? "#10b981"
    : pct >= 0.85
      ? "#ef4444"
      : pct >= 0.65
        ? "#f59e0b"
        : "#10b981";

  const cx = size / 2;
  const cy = size / 2;

  // A quarter arc reads as motion; a longer one looks like a full ring turning and
  // a shorter one like a speck.
  const spinArc = circumference * 0.25;

  return (
    <svg
      width={size}
      height={size}
      className={cn(
        "shrink-0 text-foreground",
        // `spin` wins over `pulse`: both set `animation`, so they cannot coexist, and
        // compaction (which drives `pulse`) runs DURING a stream — so honouring pulse
        // here would put the jitter straight back for the whole window that matters.
        spin ? "animate-spin" : pulse && "animate-pulse",
      )}
      aria-hidden
    >
      <circle
        cx={cx}
        cy={cy}
        r={radius}
        fill="none"
        stroke="currentColor"
        strokeOpacity={0.15}
        strokeWidth={2}
      />
      <circle
        cx={cx}
        cy={cy}
        r={radius}
        fill="none"
        stroke={color}
        strokeWidth={2}
        strokeDasharray={spin ? `${spinArc} ${circumference}` : circumference}
        strokeDashoffset={spin ? 0 : offset}
        strokeLinecap="round"
        transform={`rotate(-90 ${cx} ${cy})`}
        // No dashoffset transition while spinning: there is nothing to ease to, and
        // leaving it on is what let a re-render interrupt the rotation.
        style={{
          transition: spin
            ? "stroke 0.35s ease"
            : "stroke-dashoffset 0.3s ease, stroke 0.35s ease",
        }}
      />
    </svg>
  );
}
