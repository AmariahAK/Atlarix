import { describe, expect, it } from "vitest";
import createBm25Engine from "wink-bm25-text-search";

function tokenize(text: string): string[] {
  return String(text)
    .toLowerCase()
    .split(/[^a-z0-9_]+/)
    .filter((t) => t.length > 1);
}

describe("bm25 over ctags-shaped symbol docs", () => {
  it("ranks authentication-related symbols", () => {
    const engine = createBm25Engine();
    engine.defineConfig({ fldWeights: { title: 2, body: 1 } });
    engine.definePrepTasks([(text) => tokenize(text)]);

    const docs = [
      { title: "authenticateUser function", body: "auth token session" },
      { title: "handleLogin function", body: "login form credentials" },
      { title: "UserRepository class", body: "database persistence" },
    ];
    docs.forEach((d, i) => engine.addDoc(d, i));
    engine.consolidate();

    const results = engine.search("authentication login", 3);
    expect(results.length).toBeGreaterThan(0);
    const top = docs[results[0][0] as number];
    expect(top.title).toMatch(/auth|login/i);
  });
});
