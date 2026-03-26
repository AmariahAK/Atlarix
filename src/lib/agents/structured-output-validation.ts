import type { z } from "zod";

type RetryFn = (retryPrompt: string) => Promise<string>;

export type StructuredValidationResult<T> =
  | {
      status: "ok";
      data: T;
      normalizedText: string;
      attempts: 1 | 2;
      warning?: string;
    }
  | {
      status: "fallback";
      attempts: 2;
      warning: string;
    };

function extractJsonCandidate(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed) return trimmed;

  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenced?.[1]) return fenced[1].trim();

  return trimmed;
}

function tryParseAndValidate<T>(raw: string, schema: z.ZodType<T>): { ok: true; data: T } | { ok: false; reason: string } {
  const candidate = extractJsonCandidate(raw);
  if (!candidate) return { ok: false, reason: "empty response" };

  let parsed: unknown;
  try {
    parsed = JSON.parse(candidate);
  } catch (err) {
    return {
      ok: false,
      reason: `invalid JSON: ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  const validated = schema.safeParse(parsed);
  if (!validated.success) {
    const firstIssue = validated.error.issues[0];
    return {
      ok: false,
      reason: `schema mismatch at ${firstIssue?.path?.join(".") || "root"}: ${firstIssue?.message || "unknown issue"}`,
    };
  }

  return { ok: true, data: validated.data };
}

export async function validateStructuredOutputWithSingleRetry<T>(args: {
  rawText: string;
  schema: z.ZodType<T>;
  schemaName: string;
  schemaHint: string;
  retry: RetryFn;
}): Promise<StructuredValidationResult<T>> {
  const firstAttempt = tryParseAndValidate(args.rawText, args.schema);
  if (firstAttempt.ok) {
    return {
      status: "ok",
      data: firstAttempt.data,
      normalizedText: JSON.stringify(firstAttempt.data, null, 2),
      attempts: 1,
    };
  }

  const retryPrompt = [
    `Your previous output did not match the required schema "${args.schemaName}".`,
    `Validation error: ${firstAttempt.reason}`,
    "",
    "Return ONLY valid JSON (no markdown fences, no prose).",
    `Schema requirements: ${args.schemaHint}`,
    "",
    "Previous output:",
    args.rawText,
  ].join("\n");

  const retriedText = (await args.retry(retryPrompt)).trim();
  const secondAttempt = tryParseAndValidate(retriedText, args.schema);
  if (secondAttempt.ok) {
    return {
      status: "ok",
      data: secondAttempt.data,
      normalizedText: JSON.stringify(secondAttempt.data, null, 2),
      attempts: 2,
      warning: `Recovered after one retry for schema ${args.schemaName}.`,
    };
  }

  return {
    status: "fallback",
    attempts: 2,
    warning: `Structured output validation failed for ${args.schemaName}. Using fallback response. Last error: ${secondAttempt.reason}`,
  };
}
