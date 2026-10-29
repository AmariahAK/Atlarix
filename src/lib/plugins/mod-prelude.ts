/**
 * The JavaScript that runs INSIDE a mod's isolate before the mod itself: it
 * defines `on` and `$` in plain JS, so no host object or closure ever crosses
 * into the isolate. Everything `$` does goes through one host function,
 * `__host(op, json) → json`, and every event comes in through one function,
 * `__dispatch(event, json) → json` (mod-host.ts). Strings both ways.
 *
 * How several hooks on one event combine:
 * - `tool.call`: the first `{ deny }` wins and later hooks do not run.
 * - `prompt.submit`: each hook sees the text the previous one returned.
 * - `prompt.compose`: every `{ section }` is collected.
 * - `command.run`, `ui.render`: the first non-empty answer.
 * - `session.start`, `ui.action`: all run; answers are ignored.
 */
export const MOD_PRELUDE = String.raw`
"use strict";
(() => {
  const host = globalThis.__host;
  delete globalThis.__host;
  const hooks = [];
  const call = (op, args) => {
    const out = JSON.parse(host(op, JSON.stringify(args === undefined ? null : args)));
    if (out && out.error) throw new Error(out.error);
    return out ? out.value : undefined;
  };
  const on = (event, a, b) => {
    const hook = typeof a === "function" ? a : b;
    const matcher = typeof a === "function" ? null : a || null;
    if (typeof hook !== "function") throw new Error("on(event, [matcher,] hook)");
    hooks.push({ event: String(event), matcher, hook });
  };
  const $ = Object.freeze({
    ui: Object.freeze({
      status: (text) => call("ui.status", { text: text == null ? null : String(text) }),
      toast: (text) => call("ui.toast", { text: String(text) }),
      open: (opts) => call("ui.open", opts),
      close: (id) => call("ui.close", { id: String(id) }),
    }),
    command: Object.freeze({ register: (c) => call("command.register", c) }),
    state: Object.freeze({
      get: (key) => call("state.get", { key: String(key) }),
      set: (key, value) => call("state.set", { key: String(key), value }),
    }),
    store: Object.freeze({
      get: (key) => call("store.get", { key: String(key) }),
      set: (key, value) => call("store.set", { key: String(key), value }),
    }),
    fs: Object.freeze({ read: (p) => call("fs.read", { path: String(p) }) }),
    log: (...parts) => call("log", { text: parts.map(String).join(" ") }),
  });
  const matches = (m, e) =>
    !m ||
    ((m.tool === undefined || m.tool === e.tool) &&
      (m.component === undefined || m.component === e.component) &&
      (m.name === undefined || m.name === e.name));
  const fixed = (name, value) =>
    Object.defineProperty(globalThis, name, { value, writable: false, configurable: false });
  fixed("__register", (register) => register(on, $));
  fixed("__dispatch", (event, json) => {
    let e = JSON.parse(json);
    const sections = [];
    let answer = null;
    for (const h of hooks) {
      if (h.event !== event || !matches(h.matcher, e)) continue;
      const r = h.hook(Object.freeze({ ...e }));
      if (r === undefined || r === null) continue;
      if (event === "tool.call") {
        if (r.deny) return JSON.stringify({ deny: String(r.deny) });
      } else if (event === "prompt.submit") {
        if (typeof r.text === "string") e = { ...e, text: r.text };
        answer = { text: e.text };
      } else if (event === "prompt.compose") {
        if (typeof r.section === "string") sections.push(r.section);
      } else if (event === "command.run" || event === "ui.render") {
        if (answer === null) answer = r;
      }
    }
    if (event === "prompt.compose") return JSON.stringify(sections.length ? { sections } : null);
    return JSON.stringify(answer);
  });
})();
`;
