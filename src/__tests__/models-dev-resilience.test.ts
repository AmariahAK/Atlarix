/**
 * models.dev catalog resilience.
 *
 * The catalog is the FLOOR every cloud provider's model list stands on
 * (see `mergeByApiName` / provider-catalog-merge.test.ts), so "the catalog is
 * missing" is no longer a cosmetic problem — it empties the picker.
 *
 * Three ways it used to go missing, all covered here:
 *   1. Cold first run with no network: no disk cache existed either, so the
 *      catalog resolved to `{}`. A bundled snapshot is now the last tier.
 *   2. A non-atomic `writeFile` over the live cache: the disk-full incident
 *      behind Sentry `49d4f2a5` truncates it, and the next boot fails to parse.
 *   3. A single-shot fetch: one transient 5xx cost a full refresh interval.
 */

import {
  afterAll,
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import os from "node:os";
import path from "node:path";
import fs from "node:fs/promises";
import { gzipSync } from "node:zlib";

const TMP_ROOT = path.join(os.tmpdir(), "atlarix-models-dev-resilience-test");
const USER_DATA = path.join(TMP_ROOT, "userData");
const APP_PATH = path.join(TMP_ROOT, "app");

vi.mock("@/paths/paths", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/paths/paths")>()),
  getUserDataPath: () => USER_DATA,
}));

vi.mock("electron", () => ({
  app: { isPackaged: false, getAppPath: () => APP_PATH },
  BrowserWindow: { getAllWindows: () => [] },
}));

vi.mock("@sentry/electron/main", () => ({
  captureMessage: vi.fn(),
  captureException: vi.fn(),
}));

import {
  getModelsDevData,
  refreshModelsDev,
  resetModelsDevCache,
} from "@/lib/models_dev";

const SNAPSHOT_CATALOG = {
  anthropic: {
    id: "anthropic",
    name: "Anthropic",
    api: "https://api.anthropic.com/v1",
    models: {
      "claude-opus-4-8": {
        name: "Claude Opus 4.8",
        tool_call: true,
        limit: { context: 200000, output: 64000 },
      },
    },
  },
};

const LIVE_CATALOG = {
  anthropic: {
    id: "anthropic",
    name: "Anthropic",
    api: "https://api.anthropic.com/v1",
    models: {
      "claude-opus-4-8": { name: "Claude Opus 4.8", tool_call: true },
      "claude-newer-than-the-snapshot": {
        name: "Claude Newer",
        tool_call: true,
      },
    },
  },
};

const cachePath = () => path.join(USER_DATA, "cache", "models.json");
const snapshotPath = () =>
  path.join(APP_PATH, "build", "models-snapshot.json.gz");

async function writeSnapshot(): Promise<void> {
  await fs.mkdir(path.dirname(snapshotPath()), { recursive: true });
  await fs.writeFile(
    snapshotPath(),
    gzipSync(Buffer.from(JSON.stringify(SNAPSHOT_CATALOG), "utf-8")),
  );
}

beforeEach(async () => {
  resetModelsDevCache();
  await fs.rm(TMP_ROOT, { recursive: true, force: true }).catch(() => {});
});

afterEach(() => {
  vi.unstubAllGlobals();
});

afterAll(async () => {
  await fs.rm(TMP_ROOT, { recursive: true, force: true }).catch(() => {});
});

describe("bundled snapshot tier", () => {
  it("serves the snapshot on a cold offline start instead of an empty catalog", async () => {
    // The whole point: no disk cache, no network. Before the snapshot tier this
    // returned {} and the provider list and model picker both came up empty.
    await writeSnapshot();
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("offline");
      }),
    );

    const data = await refreshModelsDev({ notify: false });
    expect(Object.keys(data)).toContain("anthropic");
    expect(Object.keys(data.anthropic.models)).toContain("claude-opus-4-8");
  });

  it("still returns {} when there is no snapshot either", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("offline");
      }),
    );
    await expect(refreshModelsDev({ notify: false })).resolves.toEqual({});
  });

  it("prefers the disk cache over the snapshot (cache is newer)", async () => {
    await writeSnapshot();
    await fs.mkdir(path.dirname(cachePath()), { recursive: true });
    await fs.writeFile(cachePath(), JSON.stringify(LIVE_CATALOG), "utf-8");
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("offline");
      }),
    );

    const data = await refreshModelsDev({ notify: false });
    expect(Object.keys(data.anthropic.models)).toContain(
      "claude-newer-than-the-snapshot",
    );
  });

  it("getModelsDevData falls back to the snapshot without a network round-trip", async () => {
    await writeSnapshot();
    const fetchSpy = vi.fn(async () => {
      throw new Error("should not be called");
    });
    vi.stubGlobal("fetch", fetchSpy);

    const data = await getModelsDevData();
    expect(Object.keys(data)).toContain("anthropic");
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

describe("atomic cache write", () => {
  // Failure is injected at the filesystem, not by mocking node:fs/promises:
  // occupying the temp path with a DIRECTORY makes the temp write fail with
  // EISDIR, which is the same shape as the ENOSPC a full disk produces. This
  // exercises the real code path rather than a stubbed one.
  const tempPath = () => `${cachePath()}.${process.pid}.tmp`;

  it("leaves no .tmp file behind after a successful write", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({ ok: true, json: async () => LIVE_CATALOG })),
    );

    await refreshModelsDev({ notify: false });

    const entries = await fs.readdir(path.dirname(cachePath()));
    expect(entries.filter((f) => f.includes(".tmp"))).toEqual([]);
    // And the cache is complete + parseable.
    const onDisk = JSON.parse(await fs.readFile(cachePath(), "utf-8"));
    expect(Object.keys(onDisk.anthropic.models)).toContain(
      "claude-newer-than-the-snapshot",
    );
  });

  it("does not corrupt an existing cache when the new write fails", async () => {
    // The disk-full failure mode. A direct writeFile over the live file
    // truncates it, so the next boot fails JSON.parse and loses the whole
    // catalog; a temp file + rename cannot leave a partial behind.
    await fs.mkdir(path.dirname(cachePath()), { recursive: true });
    await fs.writeFile(cachePath(), JSON.stringify(LIVE_CATALOG), "utf-8");
    await fs.mkdir(tempPath(), { recursive: true });

    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({ ok: true, json: async () => SNAPSHOT_CATALOG })),
    );

    await refreshModelsDev({ notify: false });

    const onDisk = JSON.parse(await fs.readFile(cachePath(), "utf-8"));
    expect(Object.keys(onDisk.anthropic.models)).toContain(
      "claude-newer-than-the-snapshot",
    );
    await fs.rm(tempPath(), { recursive: true, force: true });
  });
});

describe("fetch retry", () => {
  it("retries a transient failure and succeeds", async () => {
    let calls = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        calls++;
        if (calls === 1) throw new Error("ECONNRESET");
        return { ok: true, json: async () => LIVE_CATALOG };
      }),
    );

    const data = await refreshModelsDev({ notify: false });
    expect(calls).toBe(2);
    expect(Object.keys(data)).toContain("anthropic");
  });

  it("retries a 5xx rather than burning the whole refresh interval", async () => {
    let calls = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        calls++;
        if (calls < 3) return { ok: false, status: 503 };
        return { ok: true, json: async () => LIVE_CATALOG };
      }),
    );

    await refreshModelsDev({ notify: false });
    expect(calls).toBe(3);
  });

  it("gives up after the retry budget and falls back", async () => {
    await writeSnapshot();
    const fetchSpy = vi.fn(async () => {
      throw new Error("ECONNRESET");
    });
    vi.stubGlobal("fetch", fetchSpy);

    const data = await refreshModelsDev({ notify: false });
    // 1 initial attempt + FETCH_RETRIES(2)
    expect(fetchSpy).toHaveBeenCalledTimes(3);
    expect(Object.keys(data)).toContain("anthropic");
  });

  it("does NOT retry an abort — the timeout budget is already spent", async () => {
    const fetchSpy = vi.fn(async () => {
      throw Object.assign(new Error("aborted"), { name: "AbortError" });
    });
    vi.stubGlobal("fetch", fetchSpy);

    await refreshModelsDev({ notify: false });
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });
});
