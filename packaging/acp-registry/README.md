# ACP registry entry

The files for Atlarix's entry in the Agent Client Protocol registry
(github.com/agentclientprotocol/registry), which Zed and JetBrains IDEs read to list agents.

To submit or update: fork the registry, copy `atlarix/` in as-is, bump `version` and the npx
`package` version to the released one (never `latest`), run its `verify_agents.py --auth-check
--agent atlarix`, and open a pull request. It is public: the owner's go-ahead first.

`icon.svg` is Rix's 16px glyph (`assets/rix/rix-glyph.svg`); the registry accepts only
`currentColor`, so don't add colours.
