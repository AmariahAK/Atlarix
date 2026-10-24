/** @jsxImportSource @opentui/react */
/**
 * The CLI's first screen when nobody is signed in (Login.tsx): a welcome and the
 * two ways in, never a text line that opened a browser by itself (owner,
 * 2026-10-17: "it would seem like a bug").
 */
import { afterEach, describe, expect, it } from "bun:test";
import { testRender } from "@opentui/react/test-utils";
import { LoginScreen, type SignInMethod } from "../src/cli/tui/Login";
import type { Line } from "../src/cli/tui/dialogs";

let current: Awaited<ReturnType<typeof testRender>> | null = null;
afterEach(() => {
  current?.renderer.destroy();
  current = null;
});

async function mount(opts: { preferCode?: boolean; signIn?: (m: SignInMethod, show: (l: Line[]) => void) => Promise<string> } = {}) {
  const calls: SignInMethod[] = [];
  const result = { email: null as string | null, quit: 0 };
  const setup = await testRender(
    <LoginScreen
      version="15.8.0"
      preferCode={opts.preferCode}
      signIn={(m, show) => {
        calls.push(m);
        return opts.signIn ? opts.signIn(m, show) : new Promise(() => {});
      }}
      onSignedIn={(e) => void (result.email = e)}
      onQuit={() => void result.quit++}
    />,
    { width: 100, height: 30, exitOnCtrlC: false },
  );
  current = setup;
  await setup.renderOnce();
  return { setup, calls, result };
}

const settle = async (setup: Awaited<ReturnType<typeof testRender>>) => {
  for (let i = 0; i < 4; i++) {
    await Bun.sleep(20);
    await setup.renderOnce();
  }
};

describe("the CLI's welcome screen", () => {
  it("welcomes, and offers the app's ways in: GitHub, Google, Discord, email, then a code", async () => {
    const { setup } = await mount();
    const frame = setup.captureCharFrame();
    expect(frame).toContain("Welcome to Atlarix");
    const order = ["Continue with GitHub", "Continue with Google", "Continue with Discord", "Continue with email", "Sign in with a code"];
    for (const label of order) expect(frame).toContain(label);
    const at = order.map((l) => frame.indexOf(l));
    expect([...at].sort((a, b) => a - b)).toEqual(at);
  });

  it("each way in starts that provider (3 = Discord)", async () => {
    const { setup, calls } = await mount();
    setup.mockInput.pressKey("3");
    await settle(setup);
    expect(calls).toEqual(["discord"]);
  });

  it("starts nothing by itself: enter signs in the chosen way", async () => {
    const { setup, calls } = await mount();
    await settle(setup);
    expect(calls).toEqual([]);
    setup.mockInput.pressEnter();
    await settle(setup);
    expect(calls).toEqual(["github"]);
    expect(setup.captureCharFrame()).toContain("Opening your browser");
  });

  it("puts the code first where there's no browser (SSH), and 2 picks the next (GitHub)", async () => {
    const { setup, calls } = await mount({ preferCode: true });
    const frame = setup.captureCharFrame();
    expect(frame.indexOf("with a code")).toBeLessThan(frame.indexOf("Continue with GitHub"));
    setup.mockInput.pressKey("2");
    await settle(setup);
    expect(calls).toEqual(["github"]);
  });

  it("shows the sign-in's own lines, then who you are, then hands over", async () => {
    let finish: (email: string) => void = () => {};
    const { setup, result } = await mount({
      signIn: (_m, show) => {
        show([{ text: "sign in, and enter this code:" }, { text: "ABCD-1234", tone: "accent", bold: true }]);
        return new Promise((r) => (finish = r));
      },
    });
    setup.mockInput.pressArrow("down");
    setup.mockInput.pressEnter();
    await settle(setup);
    expect(setup.captureCharFrame()).toContain("ABCD-1234");
    finish("john@example.com");
    await settle(setup);
    expect(setup.captureCharFrame()).toContain("Signed in as john@example.com");
    await Bun.sleep(800);
    expect(result.email).toBe("john@example.com");
  });

  it("a failed sign-in says why and offers the choices again", async () => {
    const { setup } = await mount({ signIn: () => Promise.reject(new Error("Could not start a sign-in. Check the connection and try again.")) });
    setup.mockInput.pressEnter();
    await settle(setup);
    const frame = setup.captureCharFrame();
    expect(frame).toContain("Could not start a sign-in");
    expect(frame).toContain("Continue with GitHub");
  });

  it("esc while waiting goes back; esc on the choices quits", async () => {
    const { setup, result } = await mount();
    setup.mockInput.pressEnter();
    await settle(setup);
    setup.mockInput.pressEscape();
    await settle(setup);
    expect(setup.captureCharFrame()).toContain("Sign in with a code");
    expect(result.quit).toBe(0);
    setup.mockInput.pressEscape();
    await settle(setup);
    expect(result.quit).toBe(1);
  });
});
