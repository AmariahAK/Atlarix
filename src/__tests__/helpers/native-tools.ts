import { resolveCtagsPath } from "@/lib/native/resolve-ctags-path";

export function hasCtags(): boolean {
  return resolveCtagsPath() != null;
}

export { resolveCtagsPath };
