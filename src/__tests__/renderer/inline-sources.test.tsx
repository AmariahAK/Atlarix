/**
 * v10.1: provider-native search citations — an <atlarix-sources> tag in
 * persisted message content yields citation chips (and never renders as text).
 */

import React from "react";
import { describe, it, expect, vi } from "vitest";
import { screen } from "@testing-library/react";
import { extractInlineSourcesFromContent } from "@/lib/chat/citation-sources";
import { makeFakeIpc, renderWithProviders } from "./helpers";

const fakeIpc = makeFakeIpc();

vi.mock("@/ipc/ipc_client", () => ({
  IpcClient: { getInstance: () => fakeIpc },
}));

import { AssistantMessageBody } from "@/components/chat/AssistantMessageBody";

const CONTENT =
  "The answer is 42.\n" +
  '<atlarix-sources>[{"url":"https://example.com/answer","title":"Answer Source"}]</atlarix-sources>\n';

// A turn that actually SEARCHED carries a tool-call tag, which flips
// `isStructured` (AssistantMessageBody) and routes rendering down the
// interleaved-timeline branch instead of the legacy one. Every real
// web-search reply looks like this — the plain-prose CONTENT above never
// exercises that branch.
const STRUCTURED_CONTENT =
  "<atlarix-tool-call>{}</atlarix-tool-call>\n" +
  "<atlarix-tool-result>{}</atlarix-tool-result>\n" +
  CONTENT;

describe("inline <atlarix-sources> citations", () => {
  it("extracts and normalizes sources from content", () => {
    const sources = extractInlineSourcesFromContent(CONTENT);
    expect(sources).toHaveLength(1);
    expect(sources[0].url).toBe("https://example.com/answer");
    expect(sources[0].title).toBe("Answer Source");
  });

  it("never renders the raw tag text in the message body", () => {
    renderWithProviders(
      <AssistantMessageBody
        content={CONTENT}
        isStreaming={false}
        chatId={3}
        assistantMessageId={777}
      />,
    );
    expect(screen.getByText(/The answer is 42\./)).toBeInTheDocument();
    expect(screen.queryByText(/atlarix-sources/)).not.toBeInTheDocument();
    expect(screen.queryByText(/example\.com\/answer/)).not.toBeInTheDocument();
  });

  it("renders the sources strip (card) from <atlarix-sources> on a settled turn", () => {
    renderWithProviders(
      <AssistantMessageBody
        content={CONTENT}
        isStreaming={false}
        chatId={3}
        assistantMessageId={777}
      />,
    );
    // The MessageSources card surfaces the source title — proves the strip mounts.
    expect(screen.getByText("Answer Source")).toBeInTheDocument();
  });

  it("renders the sources strip on a turn that used tools (interleaved branch)", () => {
    renderWithProviders(
      <AssistantMessageBody
        content={STRUCTURED_CONTENT}
        isStreaming={false}
        chatId={3}
        assistantMessageId={778}
      />,
    );
    // This is the shape a real Core web-search reply has. The strip must mount
    // here too, not only on the plain-prose (legacy) path.
    expect(screen.getByText("Answer Source")).toBeInTheDocument();
  });

  it("renders the sources strip when the thread is content-driven", () => {
    renderWithProviders(
      <AssistantMessageBody
        content={CONTENT}
        isStreaming={false}
        chatId={3}
        assistantMessageId={779}
        contentDrivenThread
      />,
    );
    expect(screen.getByText("Answer Source")).toBeInTheDocument();
  });
});
