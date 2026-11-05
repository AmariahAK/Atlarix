/**
 * A wake turn (a teammate's message, then the turn it starts) arrives with no
 * input from you. The peer row lands before `isStreaming` turns on, so a
 * follow gated on streaming missed that append: the view fell off the bottom
 * and the turn streamed below the fold. Follow any append while you are at the
 * bottom; stay put while you are scrolled up to read.
 */
import React, { forwardRef } from "react";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render } from "@testing-library/react";
import type { Message } from "@/ipc/ipc_types";

type FollowOutput = ((atBottom: boolean) => unknown) | unknown;
let followOutput: FollowOutput;
vi.mock("react-virtuoso", () => ({
  Virtuoso: forwardRef((props: { followOutput?: FollowOutput }, _ref) => {
    followOutput = props.followOutput;
    return <div />;
  }),
}));
vi.mock("@/components/SimpleMessage", () => ({ SimpleMessage: () => null }));

import { VirtualizedMessageList } from "@/components/VirtualizedMessageList";

const m = (id: number, role: string, content = `m${id}`) => ({ id, role, content }) as unknown as Message;

function list(isStreaming: boolean) {
  return (
    <VirtualizedMessageList
      messages={[m(1, "user"), m(2, "assistant")]}
      chatId={7}
      workspaceAppId={null}
      isStreaming={isStreaming}
      lastAssistantIndex={1}
      onEditUserMessage={async () => {}}
      onContinue={() => {}}
    />
  );
}

const follow = (atBottom: boolean) =>
  typeof followOutput === "function" ? followOutput(atBottom) : followOutput;

beforeEach(() => {
  followOutput = undefined;
});

describe("following the bottom", () => {
  it("follows an append at the bottom with no stream running", () => {
    render(list(false));
    expect(follow(true)).toBe("auto");
  });

  it("does not follow while scrolled up", () => {
    render(list(false));
    expect(follow(false)).toBe(false);
  });

  it("follows while streaming at the bottom, not when scrolled up", () => {
    render(list(true));
    expect(follow(true)).toBe("auto");
    expect(follow(false)).toBe(false);
  });
});
