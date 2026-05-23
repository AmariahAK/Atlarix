import { resolveCtagsPath } from "@/lib/native/resolve-ctags-path";

export function hasCtags(): boolean {
  return resolveCtagsPath() != null;
}

export function hasAstGrep(): boolean {
  try {
    require("@ast-grep/napi");
    return true;
  } catch {
    return false;
  }
}

export { resolveCtagsPath };
