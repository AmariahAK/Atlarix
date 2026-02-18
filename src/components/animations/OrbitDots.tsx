/**
 * OrbitDots — React Bits–style orbital loading indicator.
 * Small dots orbit around the center; use for loading states.
 */

import { cn } from "@/lib/utils";

export interface OrbitDotsProps extends React.ComponentProps<"div"> {
  size?: number;
  dotCount?: number;
  duration?: number;
}

export function OrbitDots({
  className,
  size = 32,
  dotCount = 4,
  duration = 1.2,
  ...props
}: OrbitDotsProps) {
  const dots = Array.from({ length: dotCount }, (_, i) => i);
  return (
    <div
      className={cn("atlarix-orbit-dots relative inline-block", className)}
      style={{ width: size, height: size, ["--orbit-duration" as string]: `${duration}s` }}
      {...props}
    >
      {dots.map((i) => (
        <span
          key={i}
          className="atlarix-orbit-dot absolute rounded-full bg-[#14B8A6]"
          style={{
            width: Math.max(3, size / 8),
            height: Math.max(3, size / 8),
            top: "50%",
            left: "50%",
            marginTop: -Math.max(1.5, size / 16),
            marginLeft: -Math.max(1.5, size / 16),
            animation: `atlarix-orbit var(--orbit-duration, 1.2s) linear infinite`,
            animationDelay: `${(i / dotCount) * (duration * 1000)}ms`,
          }}
        />
      ))}
    </div>
  );
}
