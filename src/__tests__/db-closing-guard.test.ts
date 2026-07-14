import { describe, it, expect } from "vitest";
import {
  db,
  beginDatabaseClosing,
  isDatabaseClosing,
  DatabaseClosingError,
} from "@/db/index";

describe("database closing guard", () => {
  it("short-circuits db access with DatabaseClosingError once shutdown begins", () => {
    expect(isDatabaseClosing()).toBe(false);
    beginDatabaseClosing();
    expect(isDatabaseClosing()).toBe(true);
    // Any property access on the db proxy now throws the recognizable error
    // instead of an opaque "connection is not open" deep in a query.
    expect(() => db.select).toThrow(DatabaseClosingError);
  });
});
