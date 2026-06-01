/**
 * Heartbeat logging while @electron/packager runs on Windows CI.
 * @deprecated import from win-ci-packager-instrumentation.mjs — kept for compatibility.
 */
export {
  logPackagerHeartbeatDetailed as logPackagerHeartbeat,
  PREFIX_HEARTBEAT,
} from "./win-ci-packager-instrumentation.mjs";
