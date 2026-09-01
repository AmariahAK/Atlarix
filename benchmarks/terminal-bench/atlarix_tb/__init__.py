from .agent import AtlarixPinnedAgent

# `AtlarixAgent` was the full out-of-tree adapter; it is now Harbor's built-in
# `atlarix` agent, and this package keeps only the pin-proxy variant used by the
# harness comparison. The alias keeps existing invocations working.
AtlarixAgent = AtlarixPinnedAgent

__all__ = ["AtlarixPinnedAgent", "AtlarixAgent"]
