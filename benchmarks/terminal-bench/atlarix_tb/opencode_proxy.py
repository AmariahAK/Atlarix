"""
opencode harbor adapter that routes opencode through the in-container pin proxy,
so opencode gets the SAME provider pin as atlarix and pi.

Why a custom `bench` provider (not opencode's built-in `openai`): opencode's
built-in `openai` provider uses the OpenAI **Responses API**
(`sdk.responses(modelID)`; see opencode provider.ts), which hits `/v1/responses`
— OpenRouter rejects that for these models ("Invalid Responses API request",
400). A custom provider declared with `npm: "@ai-sdk/openai-compatible"` has no
`.responses`, so opencode uses the **Chat Completions API** (`/v1/chat/completions`),
which is what the proxy + OpenRouter expect. This mirrors pi's `bench` provider.

We start the localhost pin proxy and register a `bench` provider pointing at it,
then defer to the normal opencode run. Invoke with `-m bench/<slug>` (e.g.
bench/deepseek/deepseek-v4-pro); opencode sends the bare slug as the API model
name, which the proxy matches against its PINS table.

Use:
  harbor run --agent-import-path atlarix_tb.opencode_proxy:BenchOpenCodeAgent \
    -m bench/deepseek/deepseek-v4-pro ...

Env (forwarded from the harbor process):
  OPENROUTER_API_KEY   required — consumed by the in-container pin proxy
"""

from harbor.agents.installed.opencode import OpenCode
from harbor.environments.base import BaseEnvironment
from harbor.models.agent.context import AgentContext

from atlarix_tb.proxy_sidecar import PROXY_API_KEY, start_sidecar


class BenchOpenCodeAgent(OpenCode):
    @staticmethod
    def name() -> str:
        return "opencode"

    async def run(
        self,
        instruction: str,
        environment: BaseEnvironment,
        context: AgentContext,
    ) -> None:
        # Start the in-container pin proxy (localhost) and register a `bench`
        # openai-compatible provider pointing at it. The base OpenCode.run()
        # deep-merges self._opencode_config over its auto-generated config, so
        # this provider block is what reaches ~/.config/opencode/opencode.json.
        base = await start_sidecar(self, environment)
        if not self.model_name or "/" not in self.model_name:
            raise ValueError("Model name must be in the format bench/<slug>")
        provider_id, model_id = self.model_name.split("/", 1)

        self._opencode_config = self._deep_merge(
            self._opencode_config,
            {
                "provider": {
                    provider_id: {
                        # openai-compatible => Chat Completions API (no Responses API)
                        "npm": "@ai-sdk/openai-compatible",
                        "name": provider_id,
                        "options": {"baseURL": base, "apiKey": PROXY_API_KEY},
                        "models": {model_id: {"name": model_id}},
                    }
                }
            },
        )
        await super().run(instruction, environment, context)
