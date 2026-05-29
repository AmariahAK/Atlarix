/** Compass animation colors — dark palette unchanged; light tuned for welcome/loading on pale UI. */

export type AtlarixAnimationPalette = {
  bg: string;
  bgMid: string;
  green: string;
  greenDark: string;
  teal: string;
  mint: string;
  mintSoft: string;
  gold: string;
  goldLight: string;
  white: string;
  dim: string;
};

export const ATLARIX_ANIMATION_PALETTE_DARK: AtlarixAnimationPalette = {
  bg: "#030a06",
  bgMid: "#071510",
  green: "#1a7a45",
  greenDark: "#0d2b1a",
  teal: "#2db87a",
  mint: "#c8ecd4",
  mintSoft: "#e8f7ee",
  gold: "#f0a800",
  goldLight: "#ffd166",
  white: "#f0f8f2",
  dim: "#1a3a28",
};

export const ATLARIX_ANIMATION_PALETTE_LIGHT: AtlarixAnimationPalette = {
  bg: "#f6fbf8",
  bgMid: "#e8f4ec",
  green: "#1a7a45",
  greenDark: "#b8dcc8",
  teal: "#1d9a62",
  mint: "#2d6b47",
  mintSoft: "#1a5c38",
  gold: "#c98500",
  goldLight: "#e6a800",
  white: "#0d2818",
  dim: "#9ec4ad",
};

export type AnimationThemeMode = "auto" | "light" | "dark";

/** Match ThemeProvider (`html.light` / `html.dark`), not OS preference alone. */
export function isAppDarkMode(): boolean {
  if (typeof document !== "undefined") {
    const root = document.documentElement;
    if (root.classList.contains("dark")) return true;
    if (root.classList.contains("light")) return false;
  }
  if (typeof window !== "undefined" && window.matchMedia) {
    return window.matchMedia("(prefers-color-scheme: dark)").matches;
  }
  return false;
}

export function resolveAnimationPalette(
  mode: AnimationThemeMode,
): AtlarixAnimationPalette {
  if (mode === "dark") return ATLARIX_ANIMATION_PALETTE_DARK;
  if (mode === "light") return ATLARIX_ANIMATION_PALETTE_LIGHT;
  return isAppDarkMode()
    ? ATLARIX_ANIMATION_PALETTE_DARK
    : ATLARIX_ANIMATION_PALETTE_LIGHT;
}
