import { describe, expect, it } from "vitest";
import * as os from "node:os";
import * as path from "node:path";
import {
  assertReadablePath,
  ENV_SECRET_BLOCK_MESSAGE,
  isBlockedSecretBasename,
  PATH_ESCAPE_BLOCK_MESSAGE,
} from "../lib/security/env-secret-paths";

const WS = path.join(os.tmpdir(), "atlarix-secret-test-ws");

describe("isBlockedSecretBasename", () => {
  it.each([
    ".env",
    ".env.local",
    ".env.production",
    ".env.staging",
    "prod.env",
    "foo.pem",
    "id_rsa.key",
    "cert.p12",
    "bundle.pfx",
    "secrets.json",
    "Credentials.JSON",
    "service-account.json",
  ])("blocks %s", (name) => {
    expect(isBlockedSecretBasename(name)).toBe(true);
  });

  it.each(["src/config.ts", "README.md", "package.json", "app.ts"])("allows %s", (name) => {
    expect(isBlockedSecretBasename(name)).toBe(false);
  });
});

describe("assertReadablePath", () => {
  it("blocks secret paths inside workspace", () => {
    expect(() => assertReadablePath(".env", WS)).toThrow(ENV_SECRET_BLOCK_MESSAGE);
    expect(() => assertReadablePath("config/.env.local", WS)).toThrow(ENV_SECRET_BLOCK_MESSAGE);
  });

  it.each([
    "../../.env",
    "./foo/../.env.local",
    "subdir/../../.env.production",
  ])("blocks traversal to secrets: %s", (p) => {
    expect(() => assertReadablePath(p, WS)).toThrow();
  });

  it("blocks escape to parent README", () => {
    expect(() => assertReadablePath("../README.md", WS)).toThrow(PATH_ESCAPE_BLOCK_MESSAGE);
  });

  it("blocks null-byte trick before .env", () => {
    expect(() => assertReadablePath(".env\u0000.txt", WS)).toThrow();
  });

  it("allows normal source files", () => {
    expect(() => assertReadablePath("src/index.ts", WS)).not.toThrow();
  });
});
