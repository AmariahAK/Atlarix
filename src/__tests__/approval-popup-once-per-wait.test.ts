/**
 * 15.11.1 (owner): one "Atlarix needs your approval" popup per wait, not one
 * per card: three edits at once raised three. A later wait, after those were
 * answered, says so again.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { EventEmitter } from "node:events";

const notify = vi.fn(async () => {});
vi.mock("@/main/agent-notification", () => ({ showAgentNotification: notify }));

const { registerInterceptor } = await import("@/ipc/handlers/permissions/handlers");

class FakeInterceptor extends EventEmitter {
  waiting: string[] = [];
  getPendingOperations() {
    return this.waiting.map((id) => ({ id, request: {} }));
  }
  releaseSettledWrites() {}
  ask(id: string) {
    this.waiting.push(id);
    this.emit("permission-request", { operationId: id, request: { operation: "edit_file", title: `Edit ${id}` } });
  }
}

beforeEach(() => notify.mockClear());

describe("the approval popup", () => {
  it("comes once for a batch of cards, and again for the next wait", () => {
    const i = new FakeInterceptor();
    registerInterceptor(901, i as never);
    i.ask("a");
    i.ask("b");
    i.ask("c");
    expect(notify).toHaveBeenCalledTimes(1);
    expect(notify).toHaveBeenCalledWith("Atlarix needs your approval", "Edit a", { chatId: 901 });

    // All three answered; later in the turn another card waits.
    i.waiting = [];
    i.ask("d");
    expect(notify).toHaveBeenCalledTimes(2);
  });
});
