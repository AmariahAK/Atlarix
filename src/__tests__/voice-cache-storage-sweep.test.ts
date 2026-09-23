import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("electron-log", () => ({
  default: { warn: vi.fn(), info: vi.fn() },
}));
vi.mock("../paths/paths", () => ({ getUserDataPath: () => "" }));

import {
  cacheNamesFromIndex,
  purgeLegacyVoiceCacheStorage,
} from "../main/startup/cleanup-orphaned-userdata";

/**
 * A Cache Storage `index.txt` as Chromium writes it: protobuf framing bytes
 * around the origin, then each cache's name and UUID directory.
 */
function fakeIndex(origin: string, names: string[]): Buffer {
  const parts: Buffer[] = [Buffer.from([0x08, 0x01, 0x12, origin.length])];
  parts.push(Buffer.from(origin, "latin1"));
  for (const name of names) {
    parts.push(Buffer.from([0x1a, 0x30, 0x0a, name.length]));
    parts.push(Buffer.from(name, "latin1"));
    parts.push(Buffer.from([0x12, 0x24]));
    parts.push(Buffer.from("3e9d4cd8-9e39-4c33-8534-cb764cc92a67", "latin1"));
  }
  parts.push(Buffer.from([0x22, origin.length]));
  parts.push(Buffer.from(origin, "latin1"));
  return Buffer.concat(parts);
}

async function makeOrigin(root: string, id: string, index: Buffer) {
  const dir = path.join(root, "Service Worker", "CacheStorage", id);
  await fs.mkdir(path.join(dir, "3e9d4cd8-9e39-4c33-8534-cb764cc92a67"), {
    recursive: true,
  });
  await fs.writeFile(path.join(dir, "index.txt"), index);
  await fs.writeFile(
    path.join(dir, "3e9d4cd8-9e39-4c33-8534-cb764cc92a67", "blob"),
    Buffer.alloc(4096),
  );
  return dir;
}

const exists = (p: string) =>
  fs.access(p).then(
    () => true,
    () => false,
  );

describe("purgeLegacyVoiceCacheStorage", () => {
  let userData: string;
  beforeEach(async () => {
    userData = await fs.mkdtemp(path.join(os.tmpdir(), "atlx-cachestorage-"));
  });
  afterEach(async () => {
    await fs.rm(userData, { recursive: true, force: true });
  });

  it("reads cache names, dropping the origin and UUIDs", () => {
    expect(
      cacheNamesFromIndex(
        fakeIndex("http://localhost:5173/", ["transformers-cache"]),
      ),
    ).toEqual(["transformers-cache"]);
  });

  it("removes an origin whose only cache is the voice model — any origin", async () => {
    const dev = await makeOrigin(
      userData,
      "046fd1ef",
      fakeIndex("http://localhost:5173/", ["transformers-cache"]),
    );
    const reclaimed = await purgeLegacyVoiceCacheStorage(userData);
    expect(await exists(dev)).toBe(false);
    expect(reclaimed).toBeGreaterThan(0);
  });

  it("leaves an origin that also holds any other cache", async () => {
    const mixed = await makeOrigin(
      userData,
      "3e8ad32e",
      fakeIndex("file:///", ["transformers-cache", "app-assets"]),
    );
    const other = await makeOrigin(
      userData,
      "aa11bb22",
      fakeIndex("file:///", ["app-assets"]),
    );
    expect(await purgeLegacyVoiceCacheStorage(userData)).toBe(0);
    expect(await exists(mixed)).toBe(true);
    expect(await exists(other)).toBe(true);
  });

  it("is a no-op when there is no Cache Storage at all", async () => {
    expect(await purgeLegacyVoiceCacheStorage(userData)).toBe(0);
  });

  it("FAILS closed on an unreadable index — the guard is real", async () => {
    const dir = path.join(userData, "Service Worker", "CacheStorage", "noidx");
    await fs.mkdir(dir, { recursive: true });
    expect(await purgeLegacyVoiceCacheStorage(userData)).toBe(0);
    expect(await exists(dir)).toBe(true);
  });
});
