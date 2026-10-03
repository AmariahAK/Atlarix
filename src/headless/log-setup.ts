/**
 * Point electron-log's file transport somewhere that exists outside Electron.
 *
 * On first write it derives the log folder from the app name, which it finds via
 * `electron.app.name` or the nearest package.json. The headless build has
 * neither once it is a compiled binary (and only by accident as an npm package),
 * so the first log line threw "electron-log: unable to load the app name" and
 * ended the run. Imported first by the entry so it runs before anything logs.
 */
import log from "electron-log";
import path from "node:path";
import os from "node:os";

log.transports.file.setAppName("Atlarix");
log.transports.file.resolvePathFn = () =>
  path.join(
    process.env.ATLARIX_USER_DATA_DIR ?? path.join(os.homedir(), ".atlarix"),
    "logs",
    "atlarix-cli.log",
  );
