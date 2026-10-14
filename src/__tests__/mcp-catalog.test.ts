import { describe, expect, it } from "vitest";
import {
  connectorNameFor,
  connectorSlugFor,
  isPublicHttpsUrl,
  missingInputs,
  normalizeRegistryServer,
  resolveInstall,
  searchCatalog,
  slimRegistryServer,
  verifiedEntries,
  VERIFIED_MCP_SERVERS,
  type RegistryRecord,
  type RegistryServer,
} from "@/shared/mcp-catalog";

/**
 * The marketplace reads the official MCP Registry, a metaregistry: it says
 * "this server is npm package X" or "it is at URL Y". These tests pin how one
 * of its entries becomes a card, what it costs to install, and where it lives.
 */

const npmServer: RegistryServer = {
  name: "io.github.acme/thing",
  description: "Does a thing",
  version: "1.2.0",
  packages: [
    {
      registryType: "npm",
      identifier: "@acme/thing-mcp",
      version: "1.2.0",
      transport: { type: "stdio" },
      environmentVariables: [
        { name: "ACME_TOKEN", isRequired: true, isSecret: true, description: "Token" },
        { name: "ACME_REGION", default: "eu" },
        { name: "ACME_FIXED", value: "on" },
      ],
      packageArguments: [{ type: "named", name: "--mode", value: "fast" }],
    },
  ],
};

const webServer: RegistryServer = {
  name: "com.example/remote",
  title: "Example",
  remotes: [
    { type: "sse", url: "https://example.com/sse" },
    {
      type: "streamable-http",
      url: "https://{tenant}.example.com/mcp",
      variables: { tenant: { description: "Your tenant", isRequired: true } },
      headers: [{ name: "X-Api-Key", isSecret: true, isRequired: true }],
    },
  ],
};

describe("a registry entry becomes a card", () => {
  it("reads a web server: streamable http only, its URL parts and headers as inputs", () => {
    const e = normalizeRegistryServer(webServer);
    expect(e.kind).toBe("web");
    expect(e.title).toBe("Example");
    expect(e.publisher).toBe("com.example");
    expect(e.options).toHaveLength(1);
    expect(e.options[0]!.inputs.map((i) => i.key)).toEqual(["var:tenant", "header:X-Api-Key"]);
    expect(e.options[0]!.inputs[1]!.secret).toBe(true);
  });

  it("reads a local package: required secrets asked for, fixed values not", () => {
    const e = normalizeRegistryServer(npmServer);
    expect(e.kind).toBe("local");
    expect(e.title).toBe("Thing");
    const keys = e.options[0]!.inputs.map((i) => i.key);
    expect(keys).toContain("env:ACME_TOKEN");
    expect(keys).toContain("env:ACME_REGION");
    expect(keys).not.toContain("env:ACME_FIXED");
    expect(e.installable).toBe(true);
  });

  it("marks a package type Atlarix cannot start as not installable", () => {
    const e = normalizeRegistryServer({
      name: "io.github.x/bundle",
      packages: [{ registryType: "mcpb", identifier: "https://x/y.mcpb" }],
    });
    expect(e.installable).toBe(false);
  });
});

describe("slimming what the catalog keeps", () => {
  it("drops a server Atlarix cannot install", () => {
    expect(slimRegistryServer({ name: "a/b", remotes: [{ type: "sse", url: "https://x/sse" }] })).toBeNull();
    expect(slimRegistryServer({ name: "a/c", packages: [{ registryType: "nuget", identifier: "X" }] })).toBeNull();
  });

  it("keeps what installing needs and trims long text", () => {
    const slim = slimRegistryServer({ ...npmServer, description: "x".repeat(1000) })!;
    expect(slim.description!.length).toBeLessThanOrEqual(300);
    expect(slim.packages![0]!.environmentVariables!.map((e) => e.name)).toEqual([
      "ACME_TOKEN",
      "ACME_REGION",
      "ACME_FIXED",
    ]);
    // A slimmed server installs exactly like the original.
    const values = { "env:ACME_TOKEN": "t" };
    expect(resolveInstall(slim, "package:0", values)).toEqual(resolveInstall(npmServer, "package:0", values));
  });
});

describe("installing", () => {
  it("runs an npm server with npx, pinned, with its env", () => {
    const r = resolveInstall(npmServer, "package:0", { "env:ACME_TOKEN": "secret" });
    expect(r).toEqual({
      transport: "stdio",
      command: "npx",
      args: ["-y", "@acme/thing-mcp@1.2.0", "--mode", "fast"],
      env: { ACME_TOKEN: "secret", ACME_REGION: "eu", ACME_FIXED: "on" },
    });
  });

  it("runs PyPI with uvx and Docker with docker run, passing env by name", () => {
    expect(
      resolveInstall({ name: "a/p", packages: [{ registryType: "pypi", identifier: "thing", version: "2.0" }] }, "package:0", {}),
    ).toMatchObject({ command: "uvx", args: ["thing==2.0"] });
    const oci = resolveInstall(
      {
        name: "a/o",
        packages: [
          {
            registryType: "oci",
            identifier: "ghcr.io/acme/thing:1.0",
            environmentVariables: [{ name: "TOKEN", isRequired: true }],
          },
        ],
      },
      "package:0",
      { "env:TOKEN": "v" },
    );
    expect(oci).toEqual({
      transport: "stdio",
      command: "docker",
      args: ["run", "-i", "--rm", "-e", "TOKEN", "ghcr.io/acme/thing:1.0"],
      env: { TOKEN: "v" },
    });
  });

  it("fills a remote's URL parts and headers", () => {
    const r = resolveInstall(webServer, "remote:1", { "var:tenant": "acme", "header:X-Api-Key": "k" });
    expect(r).toEqual({ transport: "http", url: "https://acme.example.com/mcp", headers: { "X-Api-Key": "k" } });
  });

  it("names what is still missing", () => {
    const e = normalizeRegistryServer(npmServer);
    expect(missingInputs(e.options[0]!, {})).toEqual(["Token"]);
    expect(missingInputs(e.options[0]!, { "env:ACME_TOKEN": "x" })).toEqual([]);
  });

  it("refuses an unsupported package with a sentence", () => {
    expect(() =>
      resolveInstall({ name: "a/b", packages: [{ registryType: "nuget", identifier: "X" }] }, "package:0", {}),
    ).toThrow(/cannot start nuget/);
  });
});

describe("the Verified five", () => {
  it("are Sentry, Notion, Supabase, Canva and Linear, each with a web address", () => {
    const entries = verifiedEntries(new Map());
    expect(entries.map((e) => e.title)).toEqual(["Sentry", "Notion", "Supabase", "Canva", "Linear"]);
    for (const e of entries) {
      expect(e.verified).toBe(true);
      expect(e.options[0]).toMatchObject({ kind: "web" });
      expect(isPublicHttpsUrl((e.options[0] as { url: string }).url)).toBe(true);
    }
  });

  it("keep their known address when the registry copy has none usable", () => {
    const records = new Map<string, RegistryRecord>([
      ["com.notion/mcp", { status: "active", server: { name: "com.notion/mcp", title: "Notion", remotes: [{ type: "sse", url: "https://mcp.notion.com/sse" }] } }],
    ]);
    const notion = verifiedEntries(records).find((e) => e.name === "com.notion/mcp")!;
    expect((notion.options[0] as { url: string }).url).toBe("https://mcp.notion.com/mcp");
  });

  it("rank first in every search", () => {
    const entries = [
      ...VERIFIED_MCP_SERVERS.map((v) => normalizeRegistryServer(v.fallback)),
      normalizeRegistryServer({ name: "io.github.x/linear-plus", title: "Linear", description: "unofficial" }),
      normalizeRegistryServer({ name: "io.github.y/aaa", title: "AAA" }),
    ];
    expect(searchCatalog(entries, "").entries.slice(0, 5).every((e) => e.verified)).toBe(true);
    const linear = searchCatalog(entries, "linear").entries;
    expect(linear[0]!.name).toBe("app.linear/linear");
    expect(linear).toHaveLength(2);
  });

  it("don't win a search they only match by namespace", () => {
    const entries = [
      normalizeRegistryServer(VERIFIED_MCP_SERVERS[0]!.fallback), // io.github.getsentry/…
      normalizeRegistryServer({ name: "io.github.someone/github-tools", title: "GitHub tools" }),
    ];
    const r = searchCatalog(entries, "github").entries;
    expect(r.map((e) => e.title)).toEqual(["GitHub tools"]);
  });

  it("show their own names, never the registry's generic ones", () => {
    const records = new Map<string, RegistryRecord>([
      ["com.notion/mcp", { status: "active", server: { name: "com.notion/mcp", remotes: [{ type: "streamable-http", url: "https://mcp.notion.com/mcp" }] } }],
    ]);
    expect(verifiedEntries(records).find((e) => e.name === "com.notion/mcp")!.title).toBe("Notion");
    expect(normalizeRegistryServer({ name: "com.acme/mcp" }).title).toBe("Acme");
    expect(normalizeRegistryServer({ name: "io.github.jo/server" }).title).toBe("Jo");
  });
});

describe("search", () => {
  const items = [
    { name: "io.github.a/postgres-tools", title: "Postgres tools", description: "SQL" },
    { name: "io.github.b/pg", title: "PG", description: "Talk to postgres" },
    { name: "io.github.c/other", title: "Other", description: "nothing" },
  ];
  it("needs every word to match, and ranks a title above a description", () => {
    const r = searchCatalog(items, "postgres");
    expect(r.entries.map((e) => e.name)).toEqual(["io.github.a/postgres-tools", "io.github.b/pg"]);
    expect(searchCatalog(items, "postgres nothing").total).toBe(0);
  });
  it("lists names that read as names before ones that start with punctuation", () => {
    const r = searchCatalog([{ name: "x/a", title: ":authority shape", description: "" }, { name: "x/b", title: "Zeta", description: "" }], "");
    expect(r.entries.map((e) => e.title)).toEqual(["Zeta", ":authority shape"]);
  });
  it("pages", () => {
    const r = searchCatalog(items, "", { offset: 1, limit: 1 });
    expect(r.total).toBe(3);
    expect(r.entries).toHaveLength(1);
  });
});

describe("where a URL lives", () => {
  it("puts a public https server on the account, anything local on this computer", () => {
    expect(isPublicHttpsUrl("https://mcp.linear.app/mcp")).toBe(true);
    for (const u of [
      "http://mcp.example.com/mcp",
      "https://localhost:3000/mcp",
      "https://127.0.0.1/mcp",
      "https://10.0.0.5/mcp",
      "https://192.168.1.2/mcp",
      "https://172.20.1.1/mcp",
      "https://printer.local/mcp",
      "not a url",
    ]) {
      expect(isPublicHttpsUrl(u), u).toBe(false);
    }
  });

  it("makes names and slugs the account table accepts", () => {
    expect(connectorNameFor("Linear (official) <beta>")).toBe("Linear official beta");
    expect(connectorNameFor("  ~~~ ")).toBe("Server");
    expect(connectorNameFor("x".repeat(80))).toHaveLength(60);
    expect(connectorSlugFor("Linear official beta")).toBe("linear-official-beta");
    expect(connectorSlugFor("!!!")).toBe("server");
    expect(connectorNameFor("Sentry")).toMatch(/^[A-Za-z0-9][A-Za-z0-9 ._-]{0,59}$/);
  });
});

describe("list_available_mcps stays whole (QA)", () => {
  it("cuts tool descriptions to a line, and drops them when still too long", async () => {
    const { compactListedServers } = await import("@/lib/tools/mcp");
    const long = "Does a thing. ".repeat(40);
    const mk = (name: string, n: number) => ({
      id: 1, name, scope: "account", transport: "http",
      tools: Array.from({ length: n }, (_, i) => ({ name: `${name}_tool_${i}`, description: long })),
    });
    const small = compactListedServers([mk("notion", 5)]);
    expect(small[0]!.tools[0]!.description).toBe("Does a thing.");
    const big = compactListedServers([mk("notion", 55), mk("linear", 68), mk("sentry", 200)]);
    expect(big.flatMap((s) => s.tools)).toHaveLength(323);
    expect(big[0]!.tools[0]!.description).toBeUndefined();
  });
});

describe("the publisher you searched for ranks first (QA)", () => {
  it("github → GitHub's own; brave search → Brave's own", () => {
    const items = [
      { name: "io.github.someone/github", title: "Github", description: "GitHub tools" },
      { name: "ai.smithery/github-mcp", title: "GitHub", description: "GitHub" },
      { name: "io.github.github/github-mcp-server", title: "GitHub MCP Server", description: "GitHub's official" },
      { name: "ai.smithery/brave-search", title: "Brave Search", description: "search" },
      { name: "io.github.brave/brave-search-mcp-server", title: "Brave Search MCP Server", description: "search" },
    ];
    expect(searchCatalog(items, "github").entries[0]!.name).toBe("io.github.github/github-mcp-server");
    expect(searchCatalog(items, "brave search").entries[0]!.name).toBe("io.github.brave/brave-search-mcp-server");
  });
});
