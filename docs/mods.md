# Mods

A mod is the JavaScript part of an augment: it hooks Atlarix events and draws a little UI. It runs in an
isolated JavaScript engine with no files, network, programs or Node APIs. Everything it does goes
through `$`, and only the capabilities it declares.

## In the augment

`atlarix-augment.json`:

```json
{
  "name": "counter",
  "version": "1.0.0",
  "mod": { "main": "mod/index.js", "capabilities": ["ui", "command", "state"] }
}
```

`mod/index.js` is an ES module that exports `register`. It cannot import anything.

```js
export function register(on, $) {
  $.command.register({ name: "count", description: "Count, and show it" });
  on("command.run", { name: "count" }, (e) => {
    const n = ($.state.get("n") || 0) + 1;
    $.state.set("n", n);
    $.ui.status(`count ${n}`);
    return { text: `The counter is at ${n}. ${e.args}` };
  });
}
```

The person sees every capability at the install's second confirm.

## Capabilities

| Capability | What it allows |
|---|---|
| `ui` | `$.ui.status(text)`, `$.ui.toast(text)`, `$.ui.open({ id, title })`, `$.ui.close(id)`; events `ui.render`, `ui.action` |
| `command` | `$.command.register({ name, description })`; event `command.run` |
| `prompt` | events `prompt.submit`, `prompt.compose` |
| `tool` | event `tool.call` |
| `state` | `$.state.get/set` (this session), `$.store.get/set` (kept between sessions) |
| `fs` | `$.fs.read(path)`: a file inside the open folder |

`$.log(...)` writes to Atlarix's log and needs nothing. `process` and `net` are not available yet.

## Events

`on(event, [matcher,] hook)`. A matcher narrows by `tool`, `component` or `name`.

| Event | Input | Return |
|---|---|---|
| `session.start` | `{}` | nothing |
| `tool.call` | `{ tool, args }` | `{ deny: "why" }` blocks the call; the model sees why |
| `prompt.submit` | `{ text }` | `{ text }` replaces what the model gets (the message shown stays) |
| `prompt.compose` | `{}` | `{ section }` adds context to the turn, labelled with the augment |
| `command.run` | `{ name, args }` | `{ text }` is sent to the model as the prompt |
| `ui.render` | `{ component: "Pane", requestId }` | a tree (below) |
| `ui.action` | `{ action }` | nothing; the pane is drawn again |

Hooks are synchronous. A mod can add context but never change or remove Atlarix's own.

## Panes

`ui.render` returns a tree of four elements: `Box` (`direction: "row" | "column"`), `Text`, `Button`
(`action` comes back as `ui.action`), `List`. Each takes `text` and `tone` (`muted`, `accent`, `warn`).
Anything else is dropped. The app draws panes beside the chat; the CLI shows them with `/mods`.

## Limits

Each mod has a memory limit and a time limit on every call. A mod that goes over either is turned off
until Atlarix restarts, and the person is told. A mod that throws loses that one event.
