import React from "react";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Eye, EyeOff } from "lucide-react";
import { truncateUrl } from "@/lib/format-url";

/** Editable URL field with horizontal scroll for long values. */
export function UrlInputField({
  value,
  onChange,
  placeholder,
}: {
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
}) {
  return (
    <Input
      value={value}
      onChange={(e) => onChange(e.target.value)}
      placeholder={placeholder}
      title={value.trim() || undefined}
      className="font-mono overflow-x-auto"
    />
  );
}

/** Read-only URL row with truncated label and optional full reveal. */
export function UrlReadOnlyRow({ url }: { url: string }) {
  const [showFull, setShowFull] = React.useState(false);
  const trimmed = url.trim();
  if (!trimmed) return null;

  const display = showFull ? trimmed : truncateUrl(trimmed);

  return (
    <div className="flex items-center gap-1 min-w-0 max-w-full">
      <span
        className="text-xs text-muted-foreground font-mono truncate min-w-0"
        title={trimmed}
      >
        · {display}
      </span>
      <Button
        type="button"
        variant="ghost"
        size="sm"
        className="h-6 w-6 p-0 shrink-0"
        aria-label={showFull ? "Hide full URL" : "Show full URL"}
        onClick={() => setShowFull((v) => !v)}
      >
        {showFull ? (
          <EyeOff className="h-3.5 w-3.5" />
        ) : (
          <Eye className="h-3.5 w-3.5" />
        )}
      </Button>
    </div>
  );
}
