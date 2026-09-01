"""
Pin-proxy variant of Harbor's built-in `atlarix` agent, for the harness
comparison only.

WHAT CHANGED. The adapter used to be a full `BaseInstalledAgent` living here: it
installed Node by hand, downloaded a tarball from a URL supplied in an env var,
parsed the provider itself, and passed the task text on the command line. All of
that now lives upstream in `harbor.agents.installed.atlarix:Atlarix` — installed
with `npm i -g atlarix`, ATIF trajectories, and the instruction routed through
the environment so it never enters the agent's own `/proc/<pid>/cmdline` (see
harbor issue #2311). Use `--agent atlarix` for a normal run; this file exists
ONLY for the study below.

WHY IT STILL EXISTS. The opencode comparison holds the model, provider and quant
constant across harnesses, so every harness must reach the SAME backend. When the
run goes through OpenRouter, OpenRouter is free to route a model across backends
and quantisations, and that variance would be indistinguishable from a difference
between harnesses. `pin-proxy.mjs` runs on localhost inside each task container,
injects the provider/quant pin, and forwards upstream — so the only thing left
varying is the harness. Upstream must not carry any of that: a pre-integrated
agent should talk to the provider Harbor resolved, not to a benchmark fixture.

This is the same shape `pi_proxy.py` uses over Harbor's built-in `Pi`: subclass,
redirect at the proxy, defer to the parent for everything else.

Run (matrix): `bash benchmarks/run-matrix.sh`
Run (directly):
  harbor run -d terminal-bench/terminal-bench@4.0.0 \
    --agent-import-path atlarix_tb:AtlarixPinnedAgent \
    -m openai/deepseek/deepseek-v4-flash --ak reasoning_effort=max -n 4 -y

Host env (forwarded into the container by the sidecar):
  OPENROUTER_API_KEY   required — consumed by the in-container pin proxy
  ATLARIX_OPENROUTER_PROVIDER_JSON   optional provider/quant pin
"""

from typing import override

from harbor.agents.installed.atlarix import Atlarix
from harbor.agents.model_connection import ModelConnectionSpec
from harbor.environments.base import BaseEnvironment
from harbor.models.agent.context import AgentContext

from atlarix_tb.proxy_sidecar import PROXY_API_KEY, start_sidecar


class AtlarixPinnedAgent(Atlarix):
    """Atlarix routed through the in-container pin proxy."""

    # The proxy holds the real upstream key and injects the pin, so nothing about
    # the model connection should be resolved from the host environment — the
    # parent's passthrough spec would hand Atlarix a real provider key and a real
    # base URL, and the request would bypass the proxy entirely.
    MODEL_CONNECTION = ModelConnectionSpec()

    @staticmethod
    @override
    def name() -> str:
        # Keep the upstream name so results files, `collect-results.mjs` and the
        # comparison tables read the same whichever variant produced them.
        return "atlarix"

    @override
    async def run(
        self,
        instruction: str,
        environment: BaseEnvironment,
        context: AgentContext,
    ) -> None:
        proxy_url = await start_sidecar(self, environment)

        # Point the parent at the proxy as a custom OpenAI-compatible endpoint,
        # with the dummy key the proxy expects. `_pinned_connection` is read by
        # the `model_connection` property below, which is what the parent's run()
        # consults — so the parent needs no knowledge of any of this.
        self._pinned_base_url = proxy_url
        await super().run(instruction, environment, context)

    @property
    @override
    def model_connection(self):
        access = super().model_connection
        base_url = getattr(self, "_pinned_base_url", None)
        if not base_url:
            return access
        # dataclasses.replace would be tidier, but ResolvedModelConnection carries
        # an `env` mapping the parent merges into the run env, and it must stay
        # empty here: a forwarded provider key would give Atlarix a second, real
        # route to the vendor and silently un-pin the run.
        return type(access)(
            provider=access.provider,
            api_key=PROXY_API_KEY,
            base_url=base_url,
            configured_base_url=base_url,
            env={},
        )
