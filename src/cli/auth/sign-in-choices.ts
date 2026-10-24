/**
 * The ways into Atlarix, one list for every surface that is not the app: the
 * CLI's first screen, ACP's authMethods (Zed and the other editors) and the
 * VS Code panel's first screen. The same set and words as the app's sign-in
 * (components/auth/OAuthSignInButtons.tsx), owner 2026-10-24: "the exact same
 * way as the cli and the app".
 *
 * A browser choice opens atlarix.dev/auth/app with `provider=`, so the page
 * starts that one instead of asking again; `code` is `atlarix login --device`.
 */
export type BrowserProvider = "github" | "google" | "discord" | "email";
export type SignInChoice = BrowserProvider | "code";

export const SIGN_IN_CHOICES: ReadonlyArray<{
  id: SignInChoice;
  label: string;
  detail: string;
}> = [
  { id: "github", label: "Continue with GitHub", detail: "in your browser" },
  { id: "google", label: "Continue with Google", detail: "in your browser" },
  { id: "discord", label: "Continue with Discord", detail: "in your browser" },
  {
    id: "email",
    label: "Continue with email",
    detail: "in your browser, with your email and password",
  },
  {
    id: "code",
    label: "Sign in with a code",
    detail: "for SSH, or a machine with no browser",
  },
];

export function isBrowserProvider(id: string): id is BrowserProvider {
  return (
    id === "github" || id === "google" || id === "discord" || id === "email"
  );
}
