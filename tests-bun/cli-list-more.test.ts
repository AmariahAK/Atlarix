/**
 * A list that is one page of something bigger (the MCP marketplace, ~42,000
 * servers) loads the next page as the highlight nears the end. It used to stop
 * at the first 50 rows with no sign there was more.
 */
import { describe, expect, it } from "bun:test";
import { ListDialog, type ListItem } from "../src/cli/tui/dialogs";

const page = (from: number, n: number): ListItem[] => Array.from({ length: n }, (_, i) => ({ id: `s${from + i}`, label: `Server ${from + i}` }));
const tick = () => new Promise((r) => setTimeout(r, 0));
const down = (d: ListDialog, times: number) => {
  for (let i = 0; i < times; i++) d.key({ name: "down" } as never);
};

describe("ListDialog more", () => {
  it("asks for the next page near the end, and appends it", async () => {
    const asked: Array<[string, number]> = [];
    const d = new ListDialog({
      title: "t",
      footer: "",
      searchable: true,
      search: async () => page(0, 10),
      items: page(0, 10),
      more: async (q, have) => (asked.push([q, have]), have < 30 ? page(have, 10) : []),
    });
    down(d, 3);
    expect(asked).toHaveLength(0); // not near the end yet
    down(d, 3);
    await tick();
    expect(asked).toEqual([["", 10]]);
    const v = d.view();
    expect(v.kind === "list" && v.items?.length).toBe(20);
    down(d, 20);
    await tick();
    down(d, 20);
    await tick();
    down(d, 20);
    await tick();
    // 10 → 20 → 30, then an empty answer: it stops asking.
    expect(asked.map((a) => a[1])).toEqual([10, 20, 30]);
    down(d, 5);
    await tick();
    expect(asked).toHaveLength(3);
  });

  it("a page that arrives after the search changed is dropped", async () => {
    let release!: (rows: ListItem[]) => void;
    const d = new ListDialog({
      title: "t",
      footer: "",
      searchable: true,
      search: async () => page(100, 3),
      items: page(0, 6),
      more: () => new Promise((r) => (release = r)),
    });
    down(d, 2);
    d.key({ name: "x" } as never); // types: a new search starts
    await new Promise((r) => setTimeout(r, 250));
    release(page(6, 6));
    await tick();
    const v = d.view();
    expect(v.kind === "list" && v.items?.map((i) => i.id)).toEqual(["s100", "s101", "s102"]);
  });
});
