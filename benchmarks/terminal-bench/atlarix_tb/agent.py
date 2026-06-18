"""
Harbor agent adapter for the Atlarix headless agent (Harbor >= 0.13).

Mirrors Harbor's built-in `pi` agent (harbor.agents.installed.pi): a
BaseInstalledAgent that installs Node + the prebuilt Atlarix headless bundle in
the task container, then runs it on the task instruction. Atlarix's
`run_command` executes in the container shell — which is what Terminal-Bench
verifies. opencode and pi are built-in (`-a opencode` / `-a pi`); only Atlarix
needs this custom adapter.

Run:
  harbor run -d terminal-bench/terminal-bench-2-1 \
    --agent-import-path atlarix_tb:AtlarixAgent \
    -m openrouter/deepseek/deepseek-v4-pro -n 4 -y

Host env (forwarded into the container by run()):
  OPENROUTER_API_KEY              required
  ATLARIX_HEADLESS_TARBALL_URL    required (prebuilt Linux bundle; used by install())
  ATLARIX_OPENROUTER_PROVIDER_JSON  optional provider/quant pin
"""

import os
import shlex

from harbor.agents.installed.base import BaseInstalledAgent, with_prompt_template
from harbor.environments.base import BaseEnvironment
from harbor.models.agent.context import AgentContext


class AtlarixAgent(BaseInstalledAgent):
    _OUTPUT_FILENAME = "atlarix.log"

    @staticmethod
    def name() -> str:
        return "atlarix"

    def get_version_command(self) -> str | None:
        return ". ~/.nvm/nvm.sh; node /opt/atlarix/dist-headless/atlarix-headless.mjs --version 2>/dev/null || node -v"

    async def install(self, environment: BaseEnvironment) -> None:
        url = os.environ.get("ATLARIX_HEADLESS_TARBALL_URL")
        if not url:
            raise ValueError("ATLARIX_HEADLESS_TARBALL_URL is not set")
        await self.exec_as_root(
            environment,
            command="apt-get update && apt-get install -y curl tar",
            env={"DEBIAN_FRONTEND": "noninteractive"},
        )
        # One statement per line under `set -e`: the previous &&/|| one-liner had
        # a precedence bug (`. nvm.sh || true && command -v nvm`) that let the
        # shell reach `nvm install` before the nvm function was loaded → exit 127.
        await self.exec_as_agent(
            environment,
            command=(
                "set -euo pipefail\n"
                'export NVM_DIR="$HOME/.nvm"\n'
                "curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.2/install.sh | bash\n"
                '[ -s "$NVM_DIR/nvm.sh" ] && \\. "$NVM_DIR/nvm.sh"\n'
                "command -v nvm >/dev/null || { echo 'Error: NVM failed to load' >&2; exit 1; }\n"
                "nvm install 22\n"
                "node -v\n"
                "mkdir -p /opt/atlarix\n"
                # Resumable, retrying download: the tarball may be served over a
                # bandwidth-limited tunnel that resets mid-transfer (curl 35/18/56).
                # `-C -` resumes from the partial file; loop until tar validates.
                f"URL={shlex.quote(url)}\n"
                "ok=0\n"
                "for i in 1 2 3 4 5 6 7 8 9 10; do\n"
                '  curl -fSL --retry 5 --retry-delay 3 --retry-all-errors -C - '
                '--connect-timeout 30 --max-time 900 "$URL" -o /tmp/atlarix.tar.gz || true\n'
                "  if tar -tzf /tmp/atlarix.tar.gz >/dev/null 2>&1; then ok=1; break; fi\n"
                '  echo "tarball download incomplete (attempt $i), retrying..." >&2\n'
                "  sleep 5\n"
                "done\n"
                '[ "$ok" = 1 ] || { echo "Error: tarball download failed after retries" >&2; exit 1; }\n'
                "tar -xzf /tmp/atlarix.tar.gz -C /opt/atlarix\n"
                "test -f /opt/atlarix/dist-headless/atlarix-headless.mjs\n"
            ),
        )

    @with_prompt_template
    async def run(
        self,
        instruction: str,
        environment: BaseEnvironment,
        context: AgentContext,
    ) -> None:
        escaped = shlex.quote(instruction)
        if not self.model_name or "/" not in self.model_name:
            raise ValueError("Model name must be provider/model (e.g. openai/deepseek/deepseek-v4-pro)")
        provider_id, model = self.model_name.split("/", 1)  # openai, deepseek/deepseek-v4-pro

        env: dict[str, str] = {
            "ATLARIX_HEADLESS": "1",
            "ATLARIX_DISABLE_TEXT_TOOLS": "1",
        }
        for key in ["ATLARIX_HEADLESS_TIMEOUT_MS"]:
            val = os.environ.get(key)
            if val:
                env[key] = val

        use_sidecar = os.environ.get("ATLARIX_BENCH_SIDECAR", "1") != "0"
        if use_sidecar:
            # Start the in-container pin proxy (localhost) and route Atlarix
            # through it as a custom OpenAI-compatible provider. The proxy holds
            # the real key + injects the provider pin; `model` is the bare slug
            # (e.g. deepseek/deepseek-v4-pro) so the proxy can match it. Dummy
            # key — the proxy supplies the real one upstream.
            #
            # An external (hosted) proxy is unreachable from Daytona task
            # sandboxes (egress allow-list), so the proxy must live in-container.
            from atlarix_tb.proxy_sidecar import start_sidecar, PROXY_API_KEY

            proxy_url = await start_sidecar(self, environment)
            env["ATLARIX_HEADLESS_API_KEY"] = PROXY_API_KEY
            # NOTE: deliberately NO --provider-id. headless-runner only seeds the
            # custom OpenAI-compatible provider row (at --provider-url) when
            # provider.id is undefined (atlarix-headless.mts:48 ->
            # `id: providerId ?? (providerUrl ? undefined : "openrouter")`).
            # Passing --provider-id openai defeated the proxy path entirely
            # (NoOutputGeneratedError, no request ever reached the proxy).
            provider_args = (
                f"--provider-url {shlex.quote(proxy_url)} "
                f"--model {shlex.quote(model)} --api-key {PROXY_API_KEY} "
            )
        else:
            # Direct path (e.g. local-docker smoke): OpenRouter builtin + per-request pin.
            for key in ["OPENROUTER_API_KEY", "ATLARIX_OPENROUTER_PROVIDER_JSON"]:
                val = os.environ.get(key)
                if val:
                    env[key] = val
            if os.environ.get("OPENROUTER_API_KEY"):
                env["ATLARIX_HEADLESS_API_KEY"] = os.environ["OPENROUTER_API_KEY"]
            provider_args = f"--provider-id {shlex.quote(provider_id)} --model {shlex.quote(model)} "

        await self.exec_as_agent(
            environment,
            command=(
                ". ~/.nvm/nvm.sh; "
                "node /opt/atlarix/dist-headless/atlarix-headless.mjs "
                f"{provider_args}"
                f"--prompt {escaped} "
                f"2>&1 | stdbuf -oL tee /logs/agent/{self._OUTPUT_FILENAME}"
            ),
            env=env,
        )

    def populate_context_post_run(self, context: AgentContext) -> None:
        # Terminal-Bench judges via its own in-container verifier; this is just
        # trajectory logging — confirm the run produced output.
        output_file = self.logs_dir / self._OUTPUT_FILENAME
        if not output_file.exists():
            print(f"atlarix output file not found: {output_file}")
