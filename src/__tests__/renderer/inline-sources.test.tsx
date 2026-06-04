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
});
