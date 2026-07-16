import { describe, expect, it } from "vitest";
import * as os from "node:os";
import * as path from "node:path";
import {
  assertReadablePath,
  ENV_SECRET_BLOCK_MESSAGE,
  isBlockedSecretBasename,
  isBlockedSecretPath,
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
    // Unified with the run_command danger-gate: bare SSH keys + rc credential files.
    "id_rsa",
    "id_ed25519",
    "id_ecdsa",
    "id_dsa",
    ".npmrc",
    ".netrc",
    ".git-credentials",
  ])("blocks %s", (name) => {
    expect(isBlockedSecretBasename(name)).toBe(true);
  });

  it.each(["src/config.ts", "README.md", "package.json", "app.ts", ".environment"])(
    "allows %s",
    (name) => {
      expect(isBlockedSecretBasename(name)).toBe(false);
    },
  );
});

describe("isBlockedSecretPath (two-segment credential paths)", () => {
  it.each([
    ".aws/credentials",
    "home/user/.aws/credentials",
    ".kube/config",
    ".docker/config.json",
    "id_ed25519",
    ".npmrc",
  ])("blocks %s", (p) => {
    expect(isBlockedSecretPath(p)).toBe(true);
  });

  it.each(["config/credentials", "app/config.json", "src/config.ts", "kube/config-map.yaml"])(
    "allows non-secret %s",
    (p) => {
      expect(isBlockedSecretPath(p)).toBe(false);
    },
  );
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
