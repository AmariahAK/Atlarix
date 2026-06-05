import type { ModelMessage } from "ai";

/**
 * v10.1 prompt caching — message assembly with Anthropic cache breakpoints.
 *
 * Extracted from the inline block in chat_stream_handlers.ts (simpleStreamText)
 * so the layout is unit-testable (Tier 4 provider message-shape eval) and
 * reusable by the Tier 0.1 unified loop.
 *
 * Layout:
 *  1. Stable system header — on Anthropic, carries a `cacheControl` breakpoint
 *     covering tools + system (the per-turn tail deliberately lives OUTSIDE
 *     the `system` field so this block stays cache-eligible across turns).
 *  2. Optional dynamic tail as its own system-role message (mostly day-stable).
 *  3. History — on Anthropic with ≥2 messages, a second breakpoint goes on the
 *     previous exchange's last message so the growing history caches
 *     incrementally.
 */

const ANTHROPIC_CACHE_CONTROL = {
  anthropic: { cacheControl: { type: "ephemeral" as const } },
};

export function buildStreamMessagesWithCacheBreakpoints(opts: {
  systemHeader: string;
  /** Pre-merged dynamic tail; null/empty → no tail message. */
  dynamicTail?: string | null;
  history: ModelMessage[];
  isAnthropic: boolean;
}): ModelMessage[] {
  const { systemHeader, dynamicTail, history, isAnthropic } = opts;

  return [
    {
      role: "system",
      content: systemHeader,
      ...(isAnthropic ? { providerOptions: ANTHROPIC_CACHE_CONTROL } : {}),
    },
    ...(dynamicTail && dynamicTail.trim().length > 0
      ? [{ role: "system" as const, content: dynamicTail }]
      : []),
    // Anthropic: second breakpoint on the previous exchange's last message.
    ...(isAnthropic && history.length >= 2
      ? history.map((m, i) =>
          i === history.length - 2
            ? {
                ...m,
                providerOptions: {
                  ...(m as { providerOptions?: Record<string, unknown> })
                    .providerOptions,
                  ...ANTHROPIC_CACHE_CONTROL,
                },
              }
            : m,
        )
      : history),
  ];
}
