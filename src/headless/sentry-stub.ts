/** Headless no-op stub of `@sentry/electron/main` (aliased at build time). */
const noop = () => {};
export const init = noop;
export const captureException = noop;
export const captureMessage = noop;
export const addBreadcrumb = noop;
export const setUser = noop;
export const setTag = noop;
export const setContext = noop;
export const flush = async () => true;
export default {
  init,
  captureException,
  captureMessage,
  addBreadcrumb,
  setUser,
  setTag,
  setContext,
  flush,
};
