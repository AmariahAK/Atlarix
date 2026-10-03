// `bun test tests-bun` resolves modules the way the compiled CLI does.
import { plugin } from "bun";
import { cliPlugin } from "../scripts/bun-cli-plugin";

plugin(cliPlugin(undefined, { runtime: true }));
