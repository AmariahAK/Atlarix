/**
 * The panel's first screen when nobody is signed in: Rix, a welcome, and the
 * ways in, the same as the app's sign-in, the CLI's first screen and the
 * editors' (cli/auth/sign-in-choices.ts). No chat and no message box until
 * signed in (owner, 2026-10-24: "the sign in should be the immediate first
 * thing, not a popup"). A browser choice opens atlarix.dev on that provider;
 * "Sign in with a code" shows the code here, for SSH and remote windows.
 */
import { SIGN_IN_CHOICES, type SignInChoice } from "@/cli/auth/sign-in-choices";
import { button, el, rixGlyph } from "../ui";

export type SignInView =
  | { kind: "choices"; error?: string }
  | { kind: "browser" }
  | {
      kind: "code";
      userCode: string;
      verificationUri: string;
      expiresInS: number;
    };

export interface SignInActions {
  choose(id: SignInChoice): void;
  back(): void;
  openUrl(url: string): void;
}

export function renderSignIn(
  root: HTMLElement,
  view: SignInView,
  act: SignInActions,
  version?: string,
): void {
  root.textContent = "";
  const card = el("div", "signin");
  const rix = el("div", "home__rix");
  rix.innerHTML = rixGlyph(96);
  const title = el("h1", "home__title signin__title", "Welcome to Atlarix");
  if (version) title.append(el("span", "signin__version", ` v${version}`));
  card.append(rix, title);

  if (view.kind === "choices") {
    card.append(el("p", "signin__lead", "Sign in to start."));
    const list = el("div", "signin__choices");
    for (const c of SIGN_IN_CHOICES) {
      const b = button("", "signin__choice", () => act.choose(c.id));
      b.dataset.choice = c.id;
      b.append(
        el("span", "signin__label", c.label),
        el("span", "signin__detail", c.detail),
      );
      list.append(b);
    }
    card.append(list);
    if (view.error) card.append(el("p", "signin__error", view.error));
  } else if (view.kind === "browser") {
    card.append(
      el("p", "signin__lead", "Finish signing in in your browser."),
      el(
        "p",
        "signin__detail",
        "This panel opens as soon as you're signed in.",
      ),
      button("Back", "link small", () => act.back()),
    );
  } else {
    const code = el("div", "signin__code", view.userCode);
    const link = button(view.verificationUri, "link", () =>
      act.openUrl(view.verificationUri),
    );
    card.append(
      el("p", "signin__lead", "On any device, open"),
      link,
      el("p", "signin__lead", "sign in, and enter this code:"),
      code,
      el(
        "p",
        "signin__detail",
        `It works for ${Math.round(view.expiresInS / 60)} minutes.`,
      ),
      button("Back", "link small", () => act.back()),
    );
  }
  root.append(card);
}
