const basePill = "text-[10px] px-1.5 py-0.5 rounded-full font-medium";

/**
 * Model price badge:
 *  - Atlarix Core → "Paid" (pay-as-you-go metered credit, not free).
 *  - Priced BYOK/catalog models → real output price per 1M tokens (models.dev).
 *  - Local models + genuinely $0 models → "Free".
 */
export function PriceBadge({
  cost,
  isCore,
}: {
  cost?: { input: number; output: number };
  isCore?: boolean;
}) {
  if (isCore) {
    return <span className={`${basePill} bg-primary/10 text-primary`}>Paid</span>;
  }

  const out = cost?.output ?? 0;
  const inp = cost?.input ?? 0;
  const priced = out > 0 || inp > 0;

  if (!priced) {
    return (
      <span className={`${basePill} text-primary border border-primary`}>Free</span>
    );
  }

  const label = out >= 1 ? `$${out.toFixed(2)}/M` : `$${out.toFixed(3)}/M`;
  return (
    <span
      className={`${basePill} bg-primary/10 text-primary`}
      title={`Per 1M tokens — input $${inp}, output $${out}`}
    >
      {label}
    </span>
  );
}
