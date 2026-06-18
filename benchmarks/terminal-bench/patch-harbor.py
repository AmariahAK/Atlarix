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
    for modpath in (
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
