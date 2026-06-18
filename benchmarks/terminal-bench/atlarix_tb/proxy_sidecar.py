"""
In-container pin-proxy sidecar for the Terminal-Bench harness comparison.

Why in-container (not a hosted proxy): Daytona task sandboxes enforce an egress
*allow-list*. github / npm registries / **openrouter.ai** are reachable, but
arbitrary hosts are not — a Daytona preview URL or a cloudflared tunnel both get
an immediate `Connection reset by peer` from inside the sandbox (verified). So
the pin-proxy can't live outside; it has to run on localhost inside each task
container and forward to openrouter.ai (which the allow-list permits).

Each harness (atlarix / opencode / pi) points its OpenAI-compatible base URL at
http://localhost:<PORT>/v1. The proxy (benchmarks/pin-proxy.mjs) injects the
per-model OpenRouter `provider` block, so the provider/quant is IDENTICAL for
every request regardless of what each CLI exposes — the "fixed provider" axis.

The real benchmark key lives only in the proxy process env (passed via env= on
the launch exec); the harness itself authenticates to localhost with a dummy
"sk-pin-proxy" value. (The key still has to be inside the container, because the
only reachable LLM endpoint — openrouter.ai — requires it; there is no way to
keep it off the sandbox given the allow-list. It is the isolated benchmark key,
never prod.)
"""

import base64
import pathlib

# benchmarks/terminal-bench/atlarix_tb/proxy_sidecar.py -> benchmarks/pin-proxy.mjs
_PROXY_JS = pathlib.Path(__file__).resolve().parents[2] / "pin-proxy.mjs"

PROXY_PORT = 4000
PROXY_BASE_URL = f"http://localhost:{PROXY_PORT}/v1"
PROXY_API_KEY = "sk-pin-proxy"  # dummy; proxy holds the real key server-side

# DeepInfra is NOT used — see pin-proxy.mjs PINS for the live-verified cheapest
# provider+quant per model. This module only transports the proxy; the pins live
# in one place (pin-proxy.mjs) so all three harnesses share them.


def _read_key() -> str:
    import os

    key = os.environ.get("OPENROUTER_API_KEY")
    if not key:
        raise ValueError(
            "OPENROUTER_API_KEY is not set — required by the in-container pin proxy "
            "(it is the only thing that carries the real benchmark key)."
        )
    return key


async def start_sidecar(agent, environment, port: int = PROXY_PORT) -> str:
    """Upload pin-proxy.mjs into the task container, launch it detached on
    localhost:<port>, wait until it reports listening, and return its base URL.

    `agent` is a BaseInstalledAgent (uses its exec_as_agent). Assumes Node is
    already installed (every adapter installs Node 22 via nvm in install()).
    """
    key = _read_key()
    if not _PROXY_JS.is_file():
        raise FileNotFoundError(f"pin-proxy.mjs not found at {_PROXY_JS}")
    b64 = base64.b64encode(_PROXY_JS.read_bytes()).decode()

    # 1) Materialize the proxy script (base64 round-trip avoids shell quoting).
    await agent.exec_as_agent(
        environment,
        command=(
            "mkdir -p /tmp/atlarix-proxy && "
            f"echo {b64} | base64 -d > /tmp/atlarix-proxy/pin-proxy.mjs && "
            "test -s /tmp/atlarix-proxy/pin-proxy.mjs"
        ),
    )

    # 2) Launch detached. setsid + nohup + redirected stdio + </dev/null so the
    # docker/session exec returns immediately and node survives the session
    # (otherwise exec blocks on the open stdout pipe / the child gets reaped).
    # Then poll the log until it reports listening, and fail loudly if it doesn't.
    await agent.exec_as_agent(
        environment,
        command=(
            "set -e\n"
            ". ~/.nvm/nvm.sh\n"
            "rm -f /tmp/atlarix-proxy/pin-proxy.log\n"
            "setsid bash -c 'exec node /tmp/atlarix-proxy/pin-proxy.mjs' "
            "> /tmp/atlarix-proxy/pin-proxy.log 2>&1 < /dev/null &\n"
            "for i in $(seq 1 40); do\n"
            '  grep -q \'"event":"listening"\' /tmp/atlarix-proxy/pin-proxy.log && break\n'
            "  sleep 0.5\n"
            "done\n"
            'grep -q \'"event":"listening"\' /tmp/atlarix-proxy/pin-proxy.log || '
            '{ echo "pin-proxy failed to start:" >&2; cat /tmp/atlarix-proxy/pin-proxy.log >&2; exit 1; }\n'
            # quick self-check that localhost is actually serving
            f"curl -sS -m 5 -o /dev/null -w 'pin-proxy local http %{{http_code}}\\n' "
            f"http://localhost:{port}/v1/models || true\n"
        ),
        env={"OPENROUTER_API_KEY": key, "PORT": str(port)},
    )
    return f"http://localhost:{port}/v1"
