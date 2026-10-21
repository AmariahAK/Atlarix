import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@/paths/paths", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/paths/paths")>()),
  getUserDataPath: () => "/tmp/atlarix-mcp-icons-unused",
}));

const { fetchIconAsDataUrl, isSafeSvg } = await import("@/lib/mcp/mcp-icons");

/**
 * A registry icon is a URL anyone can publish, and an SVG can carry script.
 * Main fetches it, and only a raster image or a script-free SVG ever reaches
 * the page — as a `data:` image, never inlined.
 */
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);

function serve(body: Buffer | string, type: string, status = 200) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => new Response(typeof body === "string" ? body : new Uint8Array(body), { status, headers: { "content-type": type } })),
  );
}

afterEach(() => vi.unstubAllGlobals());

describe("SVG", () => {
  it("is refused when it can do anything but draw", () => {
    for (const bad of [
      `<svg><script>alert(1)</script></svg>`,
      `<svg onload="x()"></svg>`,
      `<svg><foreignObject><div/></foreignObject></svg>`,
      `<svg><a href="https://evil.example">x</a></svg>`,
      `<svg><image xlink:href="https://track.example/p.png"/></svg>`,
      `<svg><a href="javascript:alert(1)"/></svg>`,
      `<!DOCTYPE svg [<!ENTITY x "y">]><svg/>`,
    ]) {
      expect(isSafeSvg(bad), bad).toBe(false);
    }
    expect(isSafeSvg(`<svg viewBox="0 0 1 1"><use href="#a"/><path d="M0 0h1v1z"/></svg>`)).toBe(true);
  });
});

describe("fetching an icon", () => {
  it("returns a raster image as a data URL, typed by its bytes", async () => {
    serve(PNG, "application/octet-stream");
    expect(await fetchIconAsDataUrl("https://cdn.example/icon")).toBe(`data:image/png;base64,${PNG.toString("base64")}`);
  });

  it("refuses a scripted SVG, HTML, an http URL and anything too big", async () => {
    serve(`<svg><script>x</script></svg>`, "image/svg+xml");
    expect(await fetchIconAsDataUrl("https://cdn.example/a.svg")).toBeNull();
    serve("<html>hi</html>", "text/html");
    expect(await fetchIconAsDataUrl("https://cdn.example/a")).toBeNull();
    serve(PNG, "image/png");
    expect(await fetchIconAsDataUrl("http://cdn.example/a.png")).toBeNull();
    serve(Buffer.concat([PNG, Buffer.alloc(300 * 1024)]), "image/png");
    expect(await fetchIconAsDataUrl("https://cdn.example/big.png")).toBeNull();
    serve(PNG, "image/png", 404);
    expect(await fetchIconAsDataUrl("https://cdn.example/missing.png")).toBeNull();
  });

  it("keeps a safe SVG", async () => {
    serve(`<svg viewBox="0 0 1 1"><path d="M0 0h1v1z"/></svg>`, "image/svg+xml");
    expect(await fetchIconAsDataUrl("https://cdn.example/ok.svg")).toMatch(/^data:image\/svg\+xml;base64,/);
  });
});

describe("a local server with no registry icon", () => {
  it("reads its npm scope from the command it runs", async () => {
    const { npmScopeOf } = await import("@/lib/mcp/mcp-icons");
    expect(npmScopeOf({ command: "npx", args: ["-y", "@brave/brave-search-mcp-server"] })).toBe("brave");
    expect(npmScopeOf({ command: "bunx", args: ["@modelcontextprotocol/server-filesystem@1.2.0", "/tmp"] })).toBe(
      "modelcontextprotocol",
    );
    expect(npmScopeOf({ command: "uvx", args: ["mcp-server-git"] })).toBeNull();
    expect(npmScopeOf({ command: "node", args: ["/home/me/@work/server.js"] })).toBeNull();
  });

  it("gets that scope's GitHub picture instead of a letter", async () => {
    vi.resetModules();
    vi.doMock("@/lib/mcp/registry-catalog", () => ({
      findCatalogNameFor: async () => null,
      getMcpCatalogEntry: async () => null,
    }));
    vi.doMock("@/paths/paths", async (importOriginal) => ({
      ...(await importOriginal<typeof import("@/paths/paths")>()),
      getUserDataPath: () => `/tmp/atlarix-mcp-icons-ai2a-${process.pid}`,
    }));
    const fetched: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (u: URL | string) => {
        fetched.push(String(u));
        return new Response(new Uint8Array(PNG), { status: 200, headers: { "content-type": "image/png" } });
      }),
    );
    const { getMcpIconFor } = await import("@/lib/mcp/mcp-icons");
    const icon = await getMcpIconFor({ command: "npx", args: ["-y", "@brave/brave-search-mcp-server"] });
    expect(icon).toBe(`data:image/png;base64,${PNG.toString("base64")}`);
    expect(fetched).toEqual(["https://github.com/brave.png?size=64"]);
    vi.doUnmock("@/lib/mcp/registry-catalog");
    (await import("node:fs")).rmSync(`/tmp/atlarix-mcp-icons-ai2a-${process.pid}`, { recursive: true, force: true });
  });
});
