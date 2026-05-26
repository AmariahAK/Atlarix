import { useState } from "react";
import { cn } from "@/lib/utils";
import logoUrl from "../../../assets/logo.svg?url";

export type AtlarixLogoProps = {
  className?: string;
  imgClassName?: string;
  size?: "sm" | "md" | "lg";
  showSpinner?: boolean;
};

const SIZE_PX = { sm: 48, md: 64, lg: 80 } as const;

/** Bundled logo with gradient fallback when the asset URL fails (e.g. packaged paths). */
export function AtlarixLogo({
  className,
  imgClassName,
  size = "md",
  showSpinner = false,
}: AtlarixLogoProps) {
  const [imgFailed, setImgFailed] = useState(false);
  const px = SIZE_PX[size];

  return (
    <div
      className={cn(
        "relative flex items-center justify-center rounded-full border-4 border-primary/20 bg-primary/10 overflow-hidden",
        className,
      )}
      style={{ width: px, height: px }}
    >
      <div
        className="absolute inset-0 bg-gradient-to-br from-[#10B981]/20 to-[#F59E0B]/10 blur-md"
        aria-hidden
      />
      {!imgFailed ? (
        <img
          src={logoUrl}
          alt="Atlarix"
          draggable={false}
          className={cn(
            "relative object-contain contrast-125 dark:contrast-100",
            imgClassName,
          )}
          style={{ width: Math.round(px * 0.6), height: Math.round(px * 0.6) }}
          onError={() => setImgFailed(true)}
        />
      ) : (
        <span
          className="relative text-2xl font-bold bg-gradient-to-br from-[#14B8A6] to-[#8B5CF6] bg-clip-text text-transparent"
          aria-hidden
        >
          A
        </span>
      )}
      {showSpinner && (
        <div
          className="absolute inset-0 flex items-center justify-center bg-background/40"
          aria-hidden
        >
          <div className="h-8 w-8 rounded-full border-2 border-primary border-t-transparent animate-spin" />
        </div>
      )}
    </div>
  );
}
