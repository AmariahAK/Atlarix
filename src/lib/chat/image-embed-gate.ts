/**
 * Graceful image degradation ("mixture" approach).
 *
 * User-attached images ride EVERY dispatch as native image parts — no
 * vision-capability pre-filter (opencode / Claude Code parity), so any model
 * whose API accepts images (Qwen, Gemini, Claude, GPT-4o, most OpenRouter vision
 * models, …) just works with no allowlist to maintain.
 *
 * But some OpenAI-compatible endpoints (e.g. DeepSeek V4 Pro's chat completions)
 * reject the multimodal content shape outright — "unknown variant `image_url`,
 * expected `text`". Rather than a stale capability registry that can wrongly
 * block a model that CAN see, we react to the provider's actual response: on
 * that specific rejection we replace the raw JSON deserialize error with a
 * clear, actionable "switch to a vision model" message.
 */

/** Friendly, actionable message shown when a model's API rejects image input. */
export function imageUnsupportedUserMessage(): string {
  return (
    "The image you attached couldn't be read — this model doesn't support image " +
    "input. Switch to a vision-capable model (e.g. Qwen, Gemini, Claude, or " +
    "GPT-4o) in chat settings, then resend."
  );
}

/**
 * Same treatment for a rejected PDF **document** part.
 *
 * This should be rare: PDFs are only sent natively when the models.dev catalog
 * says the exact model accepts the `pdf` input modality, and an unknown model
 * falls back to text extraction instead. What is left is a route that strips
 * file parts despite the catalog — an OpenAI-compatible proxy in front of a
 * capable model, most often — which we cannot detect ahead of time.
 *
 * The advice is deliberately concrete: extraction still works for text-based
 * PDFs, so "this PDF needs a different model" is only true for scanned ones.
 */
export function pdfUnsupportedUserMessage(): string {
  return (
    "The PDF you attached couldn't be sent to this model — its API rejected the " +
    "document. If the PDF is text-based, ask again and the agent will read the " +
    "extracted text instead. If it's a scan, switch to a model with PDF support " +
    "(e.g. Claude, Gemini, or GPT-4o) and resend."
  );
}

/**
 * Did the provider reject the PDF/file content part specifically?
 *
 * Checked BEFORE the image matcher by callers, because a request can carry both
 * and the image matcher's broader "unsupported" clauses would otherwise claim a
 * document rejection and send the user hunting for a vision model.
 */
export function isPdfContentRejectionError(err: unknown): boolean {
  const msg = collectErrorText(err);
  if (!msg) return false;

  const mentionsFilePart =
    msg.includes("input_file") ||
    msg.includes("file_url") ||
    msg.includes("document") ||
    msg.includes("application/pdf") ||
    msg.includes("pdf");
  if (!mentionsFilePart) return false;

  return (
    msg.includes("unknown variant") ||
    msg.includes("expected `text`") ||
    msg.includes("expected 'text'") ||
    msg.includes("deserialize") ||
    msg.includes("invalid_request") ||
    msg.includes("invalid request") ||
    msg.includes("not support") ||
    msg.includes("unsupported") ||
    msg.includes("does not accept") ||
    msg.includes("not a valid")
  );
}

/**
 * Does this error look like the provider REJECTING image content in the request
 * (as opposed to a network/other failure)? Matched conservatively — it only
 * matters when images were actually sent, and we only retry ONCE — so a broad
 * match at worst strips images on a turn that already failed.
 */
/**
 * Every string field the SDK might carry a provider's rejection detail in,
 * lowercased and joined.
 *
 * The detail lives in `responseBody` (or a nested `error.responseBody`) — NOT
 * the top-level `.message` — which is why this gathers rather than reads one
 * field.
 */
function collectErrorText(err: unknown): string {
  const parts: string[] = [];
  const push = (v: unknown) => {
    if (typeof v === "string" && v) parts.push(v);
  };
  if (typeof err === "string") push(err);
  if (err && typeof err === "object") {
    const e = err as Record<string, unknown> & {
      error?: Record<string, unknown>;
    };
    push(e.message);
    push(e.responseBody);
    push(e.data);
    push(e.error?.message);
    push(e.error?.responseBody);
    push(e.error?.data);
  }
  return parts.join("\n").toLowerCase();
}

export function isImageContentRejectionError(err: unknown): boolean {
  const msg = collectErrorText(err);
  if (!msg) return false;

  // The refused content part is explicitly an image.
  const mentionsImagePart =
    msg.includes("image_url") ||
    msg.includes("input_image") ||
    msg.includes("image content");

  if (mentionsImagePart) {
    return (
      msg.includes("unknown variant") ||
      msg.includes("expected `text`") ||
      msg.includes("expected 'text'") ||
      msg.includes("deserialize") ||
      msg.includes("invalid_request") ||
      msg.includes("invalid request") ||
      msg.includes("not support") ||
      msg.includes("unsupported") ||
      msg.includes("does not accept") ||
      msg.includes("not a valid")
    );
  }

  // Providers that name the capability instead of the part name.
  return (
    msg.includes("image") &&
    (msg.includes("does not support image") ||
      msg.includes("doesn't support image") ||
      msg.includes("not support images") ||
      msg.includes("no image support") ||
      msg.includes("images are not supported"))
  );
}
