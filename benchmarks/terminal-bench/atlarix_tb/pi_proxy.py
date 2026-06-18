"""
pi (badlogic/pi-coding-agent) harbor adapter that routes pi through the
pin-injecting proxy, so pi gets the same provider pin as atlarix/opencode.

pi can't carry an OpenRouter `provider` block itself, and it has no
OPENAI_BASE_URL env hook — it only takes a custom endpoint via
~/.pi/agent/models.json. So this thin subclass of the built-in PiAgent writes a
models.json defining a `bench` provider whose baseUrl is the proxy, then defers
to the normal pi run.

Use:
  harbor run --agent-import-path atlarix_tb.pi_proxy:BenchPiAgent \
    -m bench/deepseek/deepseek-v4-pro ...
  (model_name -> provider="bench", model="deepseek/deepseek-v4-pro"; the proxy
   matches on the model slug and injects the provider pin.)

Env (forwarded from the harbor process):
  OPENROUTER_API_KEY   required — consumed by the in-container pin proxy
"""

import base64
import json

from harbor.agents.installed.pi import Pi
from harbor.environments.base import BaseEnvironment
from harbor.models.agent.context import AgentContext

from atlarix_tb.proxy_sidecar import PROXY_API_KEY, start_sidecar


# Models the proxy knows how to pin. ids must match the proxy's PINS keys and
# the slug passed after "bench/" in -m.
_MODELS = [
    {"id": "deepseek/deepseek-v4-pro", "name": "deepseek/deepseek-v4-pro",
     "reasoning": True, "contextWindow": 1000000, "maxTokens": 32000},
    {"id": "minimax/minimax-m3", "name": "minimax/minimax-m3",
     "reasoning": True, "contextWindow": 500000, "maxTokens": 32000},
]


class BenchPiAgent(Pi):
    @staticmethod
    def name() -> str:
        return "pi"

    async def _write_models_json(self, environment: BaseEnvironment, base: str) -> None:
        cfg = {
            "providers": {
                "bench": {
                    "baseUrl": base,
                    "api": "openai-completions",
                    # Proxy holds the real key server-side and ignores this; any
                    # non-empty value satisfies pi's auth header.
                    "apiKey": PROXY_API_KEY,
                    "authHeader": True,
                    "models": _MODELS,
                }
            }
        }
        b64 = base64.b64encode(json.dumps(cfg, indent=2).encode()).decode()
        # base64 round-trip avoids any shell-quoting issues with the JSON.
        await self.exec_as_agent(
            environment,
            command=(
                "mkdir -p ~/.pi/agent && "
                f"echo {b64} | base64 -d > ~/.pi/agent/models.json && "
                "test -s ~/.pi/agent/models.json"
            ),
        )

    async def run(self, instruction: str, environment: BaseEnvironment, context: AgentContext) -> None:
        # Start the in-container pin proxy (localhost) and point pi's `bench`
        # provider at it. The proxy injects the OpenRouter provider pin and
        # forwards to openrouter.ai (the only reachable LLM endpoint from a
        # Daytona task sandbox).
        base = await start_sidecar(self, environment)
        await self._write_models_json(environment, base)
        await super().run(instruction, environment, context)
