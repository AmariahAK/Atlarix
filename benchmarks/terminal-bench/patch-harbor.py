#!/usr/bin/env python3
"""
Apply the Harbor `upload_dir` fix (same one pi-terminal-bench requires).

`docker cp <src> <container>:<target>` copies <src> as a SUBDIR when <target>
already exists, so an agent-created /tests dir makes the verifier's files land
at /tests/tests/test.sh and every task false-fails. The fix: append `/.` to the
source so the CONTENTS are copied. Run once after `uv tool install harbor`.
"""
import re
import shutil
import sys


def find_docker_module() -> str:
    # docker_unix first: Harbor moved the actual `docker compose cp` down into
    # the per-platform module, so the wrapper (docker.py) no longer contains the
    # call this script is about and checking it alone reports a false negative.
    for modpath in (
        "harbor.environments.docker.docker_unix",
        "harbor.environments.docker.docker",
        "harbor.environments.docker",
    ):
        try:
            mod = __import__(modpath, fromlist=["__file__"])
            if getattr(mod, "__file__", None):
                return mod.__file__
        except Exception:
            continue
    raise SystemExit("Could not locate Harbor's docker module — is harbor installed?")


def main() -> None:
    path = find_docker_module()
    src = open(path).read()

    if "rstrip('/') + '/.'" in src or 'rstrip("/") + "/."' in src:
        print(f"[patch-harbor] already patched: {path}")
        return

    # Harbor fixed this upstream (verified against v0.22.0, 2026-09-01): the
    # platform-level upload_dir now passes `f"{source_dir}/."` directly, so there
    # is nothing left to patch. Detected explicitly because the alternative is
    # this script reporting "could not find the cp call", which reads as a broken
    # patcher rather than as a fix that landed. Keep the script until the floor in
    # pyproject.toml is above every Harbor that still had the bug.
    if '/."' in src and "cp" in src:
        print(
            "[patch-harbor] nothing to do — Harbor already copies the directory "
            f"CONTENTS upstream: {path}"
        )
        return

    # Replace the cp source argument `str(source_dir)` inside the upload cp call.
    pattern = re.compile(r'(\[\s*"cp"\s*,\s*)str\(source_dir\)(\s*,\s*f"main:\{target_dir\}")')
    new_src, n = pattern.subn(r"\1(str(source_dir).rstrip('/') + '/.')\2", src)

    if n == 0:
        print(
            "[patch-harbor] Could not find the upload_dir cp call automatically.\n"
            f"  Patch manually in: {path}\n"
            "  Change the cp args from str(source_dir) to (str(source_dir).rstrip('/') + '/.')",
            file=sys.stderr,
        )
        sys.exit(1)

    shutil.copyfile(path, path + ".bak")
    open(path, "w").write(new_src)
    print(f"[patch-harbor] patched {n} site(s); backup at {path}.bak")


if __name__ == "__main__":
    main()
