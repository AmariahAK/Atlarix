/**
 * `create_relic` — hand back a document instead of a wall of code.
 *
 * The tool stores the HTML and returns an id. It does NOT open anything: the
 * relic is shown as a card in the transcript and opens in a tab when the user
 * clicks it. That ordering is the point — a model that can open tabs full of
 * its own script on its own initiative is a different and much worse product
 * than one that offers you something to look at.
 */

import {
  MAX_RELIC_BYTES,
  externalResources,
  putRelic,
  relicNote,
} from "../relics/store";
import type { ToolContext, ToolOutcome } from "./dispatch";

function str(v: unknown): string {
  return typeof v === "string" ? v : "";
}

export async function createRelic(
  args: Record<string, unknown>,
  ctx: ToolContext,
): Promise<ToolOutcome> {
  const title = str(args.title).trim() || "Untitled relic";
  const html = str(args.html);

  if (!html.trim()) {
    return {
      content: "Nothing was saved — `html` was empty.",
      label: "Made nothing",
    };
  }

  const bytes = new TextEncoder().encode(html).length;
  if (bytes > MAX_RELIC_BYTES) {
    return {
      content:
        `That relic is ${Math.round(bytes / 1024)} KB, over the ` +
        `${Math.round(MAX_RELIC_BYTES / 1024 / 1024)} MB limit. Leave out any ` +
        `embedded data you can compute in the page, or split it into two relics.`,
      label: "Relic too large",
    };
  }

  // REFUSED BEFORE IT IS SAVED, because the failure it prevents is invisible.
  // A relic whose interface is built by a CDN script opens as a blank white
  // page: the document loads, the script is blocked, nothing draws, and there
  // is nothing on screen to say why.
  const external = externalResources(html);
  if (external.length > 0) {
    return {
      content:
        `That relic was not saved — it loads ${external.length === 1 ? "a resource" : "resources"} ` +
        `from the network, which a relic cannot do: ${external.slice(0, 3).join(", ")}` +
        `${external.length > 3 ? `, and ${external.length - 3} more` : ""}. ` +
        `Relics run with no network at all. Write the CSS and JavaScript inline ` +
        `in <style> and <script> tags and send it again — plain DOM code works, ` +
        `and so do data: URLs for small images.`,
      label: "Relic needs inlining",
    };
  }

  const id = await putRelic(ctx.sessionId, { title, html });

  return {
    // WHAT THE MODEL IS TOLD IS DELIBERATELY SHORT. Echoing the HTML back would
    // put the whole document into the transcript, which is the cost this tool
    // exists to avoid — and it would then be re-sent on every later round.
    //
    // It also carries the id, because this result is the ONLY durable trace of
    // the relic: reopening the conversation has nothing else to rebuild the
    // card from. See `relicNote`.
    content: relicNote(id, title),
    label: `Made ${title}`,
    relic: { id, title },
  };
}
