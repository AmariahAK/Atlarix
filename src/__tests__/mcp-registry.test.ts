import { describe, expect, it } from "vitest";
import {
  validateMcpRegistryEntry,
  type McpRegistryEntry,
} from "@/shared/mcp-registry";

function baseEntry(overrides: Partial<McpRegistryEntry>): McpRegistryEntry {
  return {
    id: "test",
    name: "Test MCP",
    description: "Test",
    source: "https://example.com",
    installUrl: "npx @example/mcp",
    authType: "none",
    envVars: [],
    ...overrides,
  };
}

describe("validateMcpRegistryEntry", () => {
  it("requires url for oauth entries", () => {
    expect(
      validateMcpRegistryEntry(
        baseEntry({ authType: "oauth", installUrl: undefined }),
      ),
    ).toMatch(/require a url/i);
  });

  it("accepts oauth entry with valid url", () => {
    expect(
      validateMcpRegistryEntry(
        baseEntry({
          authType: "oauth",
          url: "https://mcp.example.com/v1",
          installUrl: undefined,
        }),
      ),
    ).toBeNull();
  });

  it("requires installUrl for non-oauth entries", () => {
    expect(
      validateMcpRegistryEntry(
        baseEntry({ authType: "env", installUrl: undefined }),
      ),
    ).toMatch(/installUrl/);
  });
});
