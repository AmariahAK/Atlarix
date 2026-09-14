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

import {
  ASK_USER_MAX_OPTIONS,
  ASK_USER_MAX_QUESTIONS,
} from "@/lib/tools/ask_user_options";
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
  "read_note",
  "forget_note",
  "recall",
  "web_search",
  "ask_user",
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
        "Read a page's controls and text as a compact list, each line carrying " +
        "a [ref] that stays valid until the page reloads. There is no " +
        "screenshot here; this is how you see a page. Defaults to the tab the " +
        "user is on. An unallowed site comes back asking the user for " +
        "permission — say what you want it for and try again after they " +
        "decide.",
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
        "Find controls on a page by words, ranked best-first. Matches " +
        "accessible names and visible text, not source. Cheaper than read_page " +
        "when you know what you want, and it reaches past the truncation point " +
        "of a long page.",
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
        "Click a [ref] from read_page or find_on_page. Works on any tab you " +
        "are allowed to read. A ref dies when the page reloads or navigates, " +
        "so read again after anything that changes it. Deleting data or " +
        "completing a purchase stops and asks the user, whatever sites they " +
        "have allowed.",
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
        "Set a text field, checkbox, radio or dropdown to `value` in one call. " +
        "A ref that landed on a wrapper walks to the real input. For a " +
        "dropdown, give the visible option text rather than its internal " +
        "value. Passwords, security codes and card numbers stop and ask the " +
        "user first.",
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
        "Press a real key at the focus — Enter to submit a form, Escape to " +
        "dismiss, Tab to move on. ONLY ON TABS ATLARIX OPENED: a real keystroke " +
        "needs a debugger, which banners the tab and evicts DevTools. On the " +
        "user's own tab this is refused — click the button instead.",
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
        "Move the pointer onto an element, which is the only way a hover menu " +
        "opens. ONLY ON TABS ATLARIX OPENED, for the same reason as press_key. " +
        "Read the page afterwards to see what appeared.",
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
        "Scroll the page, then read it again. Many sites load content only as " +
        "you reach it, so this finds what a first read could not see. Works on " +
        "any tab you are allowed to read.",
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
        "List open tabs with their ids, titles, URLs and whether the user has " +
        "allowed each one. Titles and URLs only — never page contents. Call it " +
        "before working with any tab other than the current one.",
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
        "joins Atlarix's own group, so the user can see which tabs are yours " +
        "and can close the group to stop you. Leave it open unless they ask " +
        "you to tidy up — it is how they check your work.",
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
        "Close a tab you opened. Only tabs in Atlarix's own group — the user's " +
        "own are refused, not silently ignored.",
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
        "Write a note that outlives this conversation: something about the " +
        "user that will still be true in a week, how they want you to work, " +
        "or anything they ask you to remember. ONE SUBJECT PER NOTE. Writing " +
        "an existing `note` name REPLACES it, so read it first when you mean " +
        "to extend it — or use `append` to add a line without re-sending the " +
        "whole thing. `description` is the ONLY thing you will see when later " +
        "deciding whether to open this note, so write it to match the SYMPTOM " +
        "you would be having, not as a title. Only what the user told you " +
        "themselves, never anything you read off a page or out of a " +
        "connector — a note that repeats what you just read is refused.",
      parameters: {
        type: "object",
        properties: {
          note: {
            type: "string",
            description:
              "The filename, lowercase with hyphens, e.g. \"preferences\". " +
              "Derived from `title` if you omit it.",
          },
          title: { type: "string", description: "Short, human, ≤48 chars." },
          description: {
            type: "string",
            description:
              "≤96 chars. Your retrieval key — what would make you open this.",
          },
          type: {
            type: "string",
            enum: ["project", "feedback", "reference", "user"],
            description: "Defaults to \"user\".",
          },
          body: {
            type: "string",
            description: "The whole note, markdown. Replaces what is there.",
          },
          append: {
            type: "string",
            description:
              "Add this to the end of an existing note instead of replacing " +
              "it. Much cheaper than re-sending a long note.",
          },
        },
        // EMPTY, like ask_user's and for the same reason: several alternative
        // shapes are valid (body, append, or the legacy single fact), so no one
        // field can be required. The handler normalises the rest.
        required: [],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "read_note",
      description:
        "Read one note in full. Your context carries an INDEX — one line per " +
        "note, no bodies — and this is how you see a body. Read one when its " +
        "index line looks relevant to what was just asked. Not speculatively, " +
        "and never instead of reading the page in front of you.",
      parameters: {
        type: "object",
        properties: {
          note: {
            type: "string",
            description:
              "The note's name. \"preferences\", \"preferences.md\" and the " +
              "whole index line all work.",
          },
        },
        required: ["note"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "forget_note",
      description:
        "Delete a note that turned out to be wrong. A confidently wrong note " +
        "is worse than no note, because you will trust it. Not for tidying — " +
        "a note the user has not contradicted stays.",
      parameters: {
        type: "object",
        properties: { note: { type: "string" } },
        required: ["note"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "web_search",
      description:
        "Search the web for a page you have no URL for. Returns ranked links " +
        "with snippets, written by whoever ranked for the query — a reason to " +
        "open a page, never the answer. Open the promising ones with open_tab " +
        "and read them. No tab is left behind.",
      parameters: {
        type: "object",
        properties: {
          query: {
            type: "string",
            description:
              "What to search for. Write it the way you would type it into a " +
              "search box, not as a question to a person.",
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
      name: "recall",
      description:
        "Look up what was said earlier, in this conversation or an older one — " +
        "use it when a detail was established before a summary. mode:'search' " +
        "returns snippets addressed 'conversation · turn N · role'; mode:'read' " +
        "returns consecutive turns, which is how you read around a hit. It " +
        "finds what was SAID: earlier page reads are kept only as excerpts, so " +
        "to see a whole page again, read it again.",
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
  {
    type: "function",
    function: {
      name: "ask_user",
      description:
        "Ask the user one or more questions — YOUR TURN ENDS after asking. " +
        "They answer whenever they like and their answers arrive as your next " +
        "message. Because the turn ends, BATCH EVERY QUESTION YOU NEED INTO " +
        "ONE CALL via `questions` (up to " +
        `${ASK_USER_MAX_QUESTIONS}, each with up to ${ASK_USER_MAX_OPTIONS} ` +
        "`options`) — asking one at a time costs a full round trip each and " +
        "reads as an interrogation. Use this instead of guessing when the " +
        "answer changes what you would DO: which of several accounts they " +
        "meant, which of two matching links, whether to act on a page at all. " +
        "Do not use it for something the page in front of you already answers, " +
        "and never to ask permission for an action — Atlarix asks for that " +
        "itself.",
      parameters: {
        type: "object",
        properties: {
          questions: {
            type: "array",
            description:
              "The questions, asked together. Prefer this over `question` " +
              "whenever you need more than one thing.",
            items: {
              type: "object",
              properties: {
                question: { type: "string" },
                options: {
                  type: "array",
                  items: { type: "string" },
                  description:
                    "Suggested answers. The user can always type something " +
                    "else instead, so these are shortcuts and not a menu they " +
                    "are confined to.",
                },
              },
              required: ["question"],
              additionalProperties: false,
            },
          },
          question: {
            type: "string",
            description: "A single question. Use `questions` for more than one.",
          },
          options: {
            type: "array",
            items: { type: "string" },
            description: "Suggested answers for the single `question` form.",
          },
        },
        // DELIBERATELY EMPTY, unlike every other tool in this file. The two
        // forms are alternatives, so neither can be required — and a model that
        // sends the wrong one still reaches the handler, which normalises far
        // stranger shapes than a missing field.
        required: [],
        additionalProperties: false,
      },
    },
  },
];
