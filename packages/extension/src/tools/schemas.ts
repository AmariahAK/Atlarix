/**
 * The tools the extension's model is given — the whole list, and no more.
 *
 * WHAT IS AVAILABLE WHERE IS NOT UNIFORM, and the split is the containment
 * model rather than an accident. `click`, `fill` and `scroll` run in the page
 * and work on any tab the user has allowed. `press_key` and `hover` need
 * TRUSTED events, which only `chrome.debugger` can produce, and attaching it
 * puts a "being debugged" banner on the tab and evicts DevTools from it. Doing
 * that to a tab the user was reading is not acceptable, so those two are
 * restricted to tabs Atlarix opened itself — the ones already in its own group,
 * where the banner is honest and the user can close the group to stop it.
 *
 * The descriptions say so, because a model that discovers this by failing burns
 * a round on it every time.
 *
 * DESCRIPTIONS ARE THE INTERFACE. A tool the model uses wrongly is usually a
 * tool described vaguely, so each one below says what it costs, when NOT to use
 * it, and what the result actually contains. The house style is the desktop's
 * `src/lib/tools/` — say the failure mode, not just the happy path.
 *
 * WHY THERE IS NO `web_search`. The obvious sixth tool would search the web,
 * and it is deliberately absent: the agent is already inside a browser, so
 * `open_tab` on a search URL followed by `read_page` is the same capability
 * with one less thing to explain, one less surface for the Web Store to ask
 * about, and no second search provider to fund. The system prompt says so
 * explicitly, because a model that has not been told will assume it cannot
 * search at all.
 */

import type { ToolSchema } from "../core/client";

/** Names the dispatcher answers to. Exported so a test can prove the two agree. */
export const TOOL_NAMES = [
  "read_page",
  "find_on_page",
  "click",
  "fill",
  "press_key",
  "hover",
  "scroll",
  "list_tabs",
  "open_tab",
  "close_tab",
  "remember",
  "recall",
] as const;

export type ToolName = (typeof TOOL_NAMES)[number];

/**
 * JSON Schema for the tool list sent to the proxy.
 *
 * `additionalProperties: false` on every one. Without it a model that invents
 * `{"url": "...", "wait_for": "networkidle"}` gets silent acceptance of a
 * parameter nothing reads, and then blames the tool when the page was not
 * settled. Refusing the call is the faster lesson.
 */
export const TOOL_SCHEMAS: ToolSchema[] = [
  {
    type: "function",
    function: {
      name: "read_page",
      description:
        "Read a page's interactive controls and text as a compact list, each " +
        "line carrying a [ref] that is stable for as long as the page is not " +
        "reloaded. This is the cheap way to see a page — far cheaper than a " +
        "screenshot, which is not available here at all. Defaults to the tab " +
        "the user is looking at. Reading a site the user has not yet allowed " +
        "will come back asking for permission, which is normal: say what you " +
        "want to read it for and try again after they decide.",
      parameters: {
        type: "object",
        properties: {
          tab_id: {
            type: "number",
            description:
              "Which tab to read. Omit for the tab the user is currently on. " +
              "Use list_tabs to get ids.",
          },
          filter: {
            type: "string",
            enum: ["interactive", "all"],
            description:
              '"interactive" (the default) lists links, buttons and fields — ' +
              'use it to decide where to go next. "all" adds the page\'s text ' +
              "content and is several times larger — use it when the question " +
              "is about what the page SAYS rather than what it offers.",
          },
        },
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "find_on_page",
      description:
        "Find controls on a page by words, ranked best-first. Prefer this over " +
        "read_page when you already know what you are looking for — a long " +
        "page truncates, and the thing you want is often past the cut. Matches " +
        "accessible names and visible text, not source code.",
      parameters: {
        type: "object",
        properties: {
          query: {
            type: "string",
            description:
              'What to look for, in the page\'s own words, e.g. "sign in" or ' +
              '"add to basket". Fewer words match more.',
          },
          tab_id: {
            type: "number",
            description: "Which tab. Omit for the tab the user is on.",
          },
        },
        required: ["query"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "click",
      description:
        "Click a link, button or control by its [ref] from read_page or " +
        "find_on_page. Works on any tab you are allowed to read. Refs stop " +
        "working when the page reloads or navigates, so read the page again " +
        "after anything that changes it. Clicking something that looks like it " +
        "deletes data or completes a purchase will stop and ask the user, every " +
        "time, no matter which sites they have allowed.",
      parameters: {
        type: "object",
        properties: {
          ref: {
            type: "string",
            description: 'A ref such as "e12". Prefer this over a selector.',
          },
          selector: {
            type: "string",
            description:
              "A CSS selector, as a fallback when you have no ref. Less " +
              "reliable: it is your guess about the page rather than something " +
              "the page told you.",
          },
          tab_id: {
            type: "number",
            description: "Which tab. Omit for the tab the user is on.",
          },
        },
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "fill",
      description:
        "Put a value into a text field, checkbox, radio or dropdown. Handles a " +
        "ref that landed on a wrapper rather than the field itself, which is " +
        "common — it walks to the real input. For a dropdown, give the option " +
        "text you can see, not its internal value. This does NOT submit " +
        "anything: to submit, click the button or use press_key with Enter. " +
        "Entering a password, security code or card number always stops and " +
        "asks the user first.",
      parameters: {
        type: "object",
        properties: {
          ref: { type: "string", description: 'A ref such as "e7".' },
          selector: { type: "string", description: "A CSS selector fallback." },
          value: {
            type: "string",
            description:
              'The text to enter. For a checkbox use "true" or "false"; ' +
              "for a dropdown use the visible option text.",
          },
          tab_id: {
            type: "number",
            description: "Which tab. Omit for the tab the user is on.",
          },
        },
        required: ["value"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "press_key",
      description:
        "Press a real key — Enter to submit a form, Escape to dismiss, Tab to " +
        "move on. ONLY WORKS ON TABS ATLARIX OPENED, because producing a real " +
        "keystroke requires attaching a debugger, which puts a banner on the " +
        "tab and takes DevTools away from whoever was using it. On one of the " +
        "user's own tabs this is refused — click the button instead. The key " +
        "goes wherever the focus is, so fill or click the field first.",
      parameters: {
        type: "object",
        properties: {
          key: {
            type: "string",
            description:
              "Enter, Escape, Tab, Backspace, Delete, ArrowUp, ArrowDown, " +
              "ArrowLeft, ArrowRight, Home, End, PageUp or PageDown.",
          },
          tab_id: {
            type: "number",
            description: "Which tab. Must be one Atlarix opened.",
          },
        },
        required: ["key"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "hover",
      description:
        "Move the pointer onto an element, which is the only way a menu that " +
        "opens on hover will open. ONLY WORKS ON TABS ATLARIX OPENED, for the " +
        "same reason as press_key. A hover changes nothing on its own — read " +
        "the page afterwards to see what appeared.",
      parameters: {
        type: "object",
        properties: {
          ref: { type: "string", description: 'A ref such as "e4".' },
          selector: { type: "string", description: "A CSS selector fallback." },
          tab_id: {
            type: "number",
            description: "Which tab. Must be one Atlarix opened.",
          },
        },
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "scroll",
      description:
        "Scroll the page. Use this when a read says the page is truncated or " +
        "that there is more below — many sites load content only as you reach " +
        "it, so scrolling then reading again finds things a first read could " +
        "not see. Works on any tab you are allowed to read.",
      parameters: {
        type: "object",
        properties: {
          direction: {
            type: "string",
            enum: ["up", "down", "top", "bottom"],
            description: 'Which way. "top" and "bottom" jump the whole page.',
          },
          amount: {
            type: "number",
            description:
              "Pixels, for up/down. Omit for about one screen, which is what " +
              "you usually want.",
          },
          tab_id: {
            type: "number",
            description: "Which tab. Omit for the tab the user is on.",
          },
        },
        required: ["direction"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "list_tabs",
      description:
        "List the browser's open tabs with their ids, titles and URLs, and " +
        "whether the user has allowed Atlarix to read each one. Call this " +
        "before working with any tab other than the current one. It reads " +
        "titles and URLs only — never the contents of a page.",
      parameters: {
        type: "object",
        properties: {},
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "open_tab",
      description:
        "Open an http(s) URL in a new tab and wait for it to load. The tab " +
        "joins Atlarix's own tab group, so the user can see at a glance which " +
        "tabs are yours and can close the whole group to stop you. THERE IS NO " +
        "SEPARATE SEARCH TOOL — to search the web, open a search engine's URL " +
        "with the query in it and then read the results page.",
      parameters: {
        type: "object",
        properties: {
          url: {
            type: "string",
            description:
              "Full http(s) URL including the scheme. Other schemes are refused.",
          },
        },
        required: ["url"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "close_tab",
      description:
        "Close a tab you opened, when you are done with it. Only tabs in " +
        "Atlarix's own group can be closed — the user's own tabs are not " +
        "yours to close, and trying is refused rather than silently ignored.",
      parameters: {
        type: "object",
        properties: {
          tab_id: { type: "number", description: "The tab to close." },
        },
        required: ["tab_id"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "remember",
      description:
        "Save one fact about the user that should still be true in a week — " +
        "how they like things done, what they are working on, a preference " +
        "they have stated twice. It is shown to you at the start of every " +
        "later conversation. Do NOT save it because it is useful right now: " +
        "this conversation already has it, and a memory store full of " +
        "yesterday's context is worse than an empty one. Never save anything " +
        "you read off a page — only what the user told you themselves.",
      parameters: {
        type: "object",
        properties: {
          fact: {
            type: "string",
            description:
              "One fact, in one sentence, written so it makes sense with no " +
              "other context.",
          },
        },
        required: ["fact"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "recall",
      description:
        "Look up what was said earlier — in this conversation or an older one. " +
        "Use it when you are missing a detail that was established before a " +
        "summary, instead of guessing or asking the user to repeat themselves. " +
        "mode:'search' finds a phrase and returns snippets addressed as " +
        "'conversation · turn N · role'; mode:'read' returns consecutive turns " +
        "from one conversation, which is how you read around a hit. Earlier " +
        "tool results are kept only as excerpts, so if you need the whole of a " +
        "page you read before, read the page again — this finds what was SAID.",
      parameters: {
        type: "object",
        properties: {
          mode: {
            type: "string",
            enum: ["search", "read"],
            description:
              "'search' for a phrase, 'read' for consecutive turns. Defaults " +
              "to 'search'.",
          },
          query: {
            type: "string",
            description:
              "The phrase to find. Required in search mode. A distinctive word " +
              "beats a sentence — this is a plain substring match, not a " +
              "semantic one.",
          },
          conversation: {
            type: "string",
            description:
              "Which conversation: leave it out for this one, 'all' for every " +
              "conversation on this device, or part of an earlier " +
              "conversation's title.",
          },
          offset: {
            type: "number",
            description: "Turns to skip in read mode. Defaults to 0.",
          },
          limit: {
            type: "number",
            description: "How many hits or turns to return.",
          },
        },
        required: [],
        additionalProperties: false,
      },
    },
  },
];
