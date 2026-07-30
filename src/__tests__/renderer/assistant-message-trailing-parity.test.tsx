/**
 * `AssistantMessageBody` returns from two structurally parallel branches —
 * interleaved timeline (`contentDrivenThread || isStructured`) and legacy — and
 * every feature wired into the tail of one has historically missed the other:
 *
 *  - the web-search citation strip was interleaved-only (so it never rendered for
 *    the turns that actually had citations),
 *  - the sub-agent round panel was the mirror image (legacy never had one),
 *  - `postStreamSubagentItems` was interleaved-only, and the legacy trailing answer
 *    was built without `citationSources` so inline `[^n]` markers never resolved.
 *
 * The trailing concerns now live in ONE `MessageTrailing` component rendered by both
 * branches. This test is the guard: it renders the SAME fixture through each branch
 * and asserts the trailing elements appear in both, exactly once. A future "render X
 * at the tail" that regresses to per-branch code fails here.
 */

import React from "react";
import { describe, it, expect, vi } from "vitest";
import { screen } from "@testing-library/react";
import { makeFakeIpc, renderWithProviders } from "./helpers";

const fakeIpc = makeFakeIpc();

vi.mock("@/ipc/ipc_client", () => ({
  IpcClient: { getInstance: () => fakeIpc },
}));

import { AssistantMessageBody } from "@/components/chat/AssistantMessageBody";

const PROSE = "Final answer: the parser was off by one.";
const SOURCE_TITLE = "Parser Docs";
const BODY =
  `${PROSE}\n` +
  `<atlarix-sources>[{"url":"https://example.com/parser","title":"${SOURCE_TITLE}"}]</atlarix-sources>\n`;

/**
 * `isStructured` keys off `<think>` / `<atlarix-tool-*>` in the content, so adding a
 * tool tag is what routes a message down the interleaved branch. `<atlarix-sources>`
 * alone does not — which is why the plain fixture exercises the legacy path.
 */
const STRUCTURED_BODY =
  "<atlarix-tool-call>{}</atlarix-tool-call>\n" +
  "<atlarix-tool-result>{}</atlarix-tool-result>\n" +
  BODY;

type Branch = { name: string; content: string; contentDrivenThread: boolean };

const BRANCHES: Branch[] = [
  // Neither flag set → legacy branch.
  { name: "legacy", content: BODY, contentDrivenThread: false },
  // isStructured true → interleaved branch.
  { name: "interleaved (isStructured)", content: STRUCTURED_BODY, contentDrivenThread: false },
  // The prop forces interleaved even for plain prose (ephemeral/floating chat).
  { name: "interleaved (contentDrivenThread)", content: BODY, contentDrivenThread: true },
];

describe("AssistantMessageBody — trailing parity across both render branches", () => {
  for (const branch of BRANCHES) {
    describe(branch.name, () => {
      const render = () =>
        renderWithProviders(
          <AssistantMessageBody
            content={branch.content}
            isStreaming={false}
            chatId={3}
            assistantMessageId={4242}
            contentDrivenThread={branch.contentDrivenThread}
          />,
        );

      it("renders the trailing answer prose", () => {
        render();
        expect(screen.getByText(new RegExp(PROSE.slice(0, 20)))).toBeInTheDocument();
      });

      it("renders the citation sources strip exactly once", () => {
        render();
        // MessageSources surfaces the title — proves the strip mounted.
        expect(screen.getAllByText(SOURCE_TITLE)).toHaveLength(1);
      });

      it("never leaks the raw <atlarix-sources> tag as text", () => {
        render();
        expect(screen.queryByText(/atlarix-sources/)).not.toBeInTheDocument();
        expect(screen.queryByText(/example\.com\/parser/)).not.toBeInTheDocument();
      });

      it("does not duplicate the answer prose", () => {
        render();
        // The tail and the branch middle both used to be able to emit the answer;
        // a duplicate here means the shared trailing is being rendered twice.
        const hits = screen.queryAllByText(new RegExp(PROSE.slice(0, 20)));
        expect(hits).toHaveLength(1);
      });
    });
  }
});
