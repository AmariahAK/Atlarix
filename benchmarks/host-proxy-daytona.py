#!/usr/bin/env python3
"""
Stand up the pin-injecting proxy (pin-proxy.mjs) inside a Daytona sandbox and
expose it via a public preview URL, so all three Terminal-Bench harnesses can
route their LLM traffic through it (identical provider pin, zero prod risk).

The proxy holds the BENCHMARK OpenRouter key server-side; the sandboxes that run
the harnesses only ever see the proxy URL, never the key.

Env:  OPENROUTER_API_KEY (benchmark key), DAYTONA_API_KEY
Writes:  /tmp/proxy-url.txt (base URL incl. /v1), /tmp/proxy-sandbox.txt (id)

Run:   python benchmarks/host-proxy-daytona.py
Stop:  python benchmarks/host-proxy-daytona.py --stop   (deletes the sandbox)
"""
import os
import sys
import time
import urllib.request

from daytona import Daytona, CreateSandboxFromImageParams, SessionExecuteRequest

HERE = os.path.dirname(os.path.abspath(__file__))
PROXY_SRC = os.path.join(HERE, "pin-proxy.mjs")
PORT = 4000
LABEL = {"role": "atlarix-bench-pin-proxy"}
URL_FILE = "/tmp/proxy-url.txt"
ID_FILE = "/tmp/proxy-sandbox.txt"


def _client() -> Daytona:
    if not os.environ.get("DAYTONA_API_KEY"):
        sys.exit("DAYTONA_API_KEY not set")
    return Daytona()


def stop():
    d = _client()
    sid = None
    if os.path.exists(ID_FILE):
        sid = open(ID_FILE).read().strip()
    # Also sweep any sandbox carrying our label, so we never leak a paid sandbox.
    killed = []
    try:
        for sb in d.list():
            labels = getattr(sb, "labels", {}) or {}
            if labels.get("role") == LABEL["role"] or (sid and sb.id == sid):
                d.delete(sb)
                killed.append(sb.id)
    except Exception as e:
        print(f"(list/delete warning: {e})")
    if sid and sid not in killed:
        try:
            d.delete(d.get(sid)); killed.append(sid)
        except Exception as e:
            print(f"(delete {sid} warning: {e})")
    for f in (URL_FILE, ID_FILE):
        if os.path.exists(f):
            os.remove(f)
    print(f"stopped/deleted: {killed or 'none'}")


def start():
    key = os.environ.get("OPENROUTER_API_KEY")
    if not key:
        sys.exit("OPENROUTER_API_KEY (benchmark key) not set")
    d = _client()

    print("[host-proxy] creating Daytona sandbox (node:22, public)...")
    sandbox = d.create(
        CreateSandboxFromImageParams(
            image="node:22-bookworm",
            public=True,                 # preview URL reachable without a token
            env_vars={"OPENROUTER_API_KEY": key, "PORT": str(PORT)},
            labels=LABEL,
            auto_stop_interval=0,        # never auto-stop during the run
        ),
        timeout=300,
    )
    open(ID_FILE, "w").write(sandbox.id)
    print(f"[host-proxy] sandbox id: {sandbox.id}")

    print("[host-proxy] uploading pin-proxy.mjs...")
    sandbox.fs.upload_file(PROXY_SRC, "/root/pin-proxy.mjs")

    print("[host-proxy] starting proxy (background session)...")
    sid = "pin-proxy"
    sandbox.process.create_session(sid)
    sandbox.process.execute_session_command(
        sid,
        SessionExecuteRequest(
            command="node /root/pin-proxy.mjs > /root/proxy.log 2>&1",
            run_async=True,
        ),
    )

    # Wait for the proxy to report listening.
    deadline = time.time() + 90
    listening = False
    while time.time() < deadline:
        r = sandbox.process.exec("cat /root/proxy.log 2>/dev/null || true")
        out = (getattr(r, "result", "") or getattr(getattr(r, "artifacts", None), "stdout", "")) or ""
        if '"event":"listening"' in out:
            listening = True
            break
        time.sleep(2)
    if not listening:
        print("[host-proxy] WARN: proxy did not report listening; last log:")
        print(out[-800:])

    link = sandbox.get_preview_link(PORT)
    base = link.url.rstrip("/") + "/v1"
    token = getattr(link, "token", None)
    open(URL_FILE, "w").write(base)
    print(f"[host-proxy] preview URL: {link.url}")
    print(f"[host-proxy] base (for harnesses): {base}")
    if token:
        print(f"[host-proxy] NOTE: sandbox token present ({token[:6]}...) — public should not need it")

    # End-to-end canary straight through the public URL: prove it forwards + injects.
    print("[host-proxy] canary: tiny chat request through the public proxy URL...")
    body = (
        b'{"model":"deepseek/deepseek-v4-pro",'
        b'"messages":[{"role":"user","content":"reply with one word: ok"}],'
        b'"max_tokens":5,"stream":false}'
    )
    req = urllib.request.Request(base + "/chat/completions", data=body,
                                 headers={"content-type": "application/json"}, method="POST")
    try:
        with urllib.request.urlopen(req, timeout=90) as resp:
            print(f"[host-proxy] canary HTTP {resp.status} (proxy reachable + forwarding)")
    except Exception as e:
        print(f"[host-proxy] canary error: {e}")
    # Show the proxy's own log line so we can confirm the pin was injected.
    r = sandbox.process.exec("tail -3 /root/proxy.log 2>/dev/null || true")
    out = (getattr(r, "result", "") or "")
    print("[host-proxy] proxy log tail:\n" + out)
    print(f"\n[host-proxy] READY. Base URL written to {URL_FILE}")


if __name__ == "__main__":
    if "--stop" in sys.argv:
        stop()
    else:
        start()
