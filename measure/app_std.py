# ASGI app for the httptools measurements. Same reply as app.py (200 "ok" with
# a length), and on every request it reports, on stderr, which uvicorn protocol
# object is serving THIS request and which event loop runs it: the protocol
# whose `cycle.scope` is the very scope dict handed to this app. That names the
# live protocol class, not just an installed package.
import asyncio
import gc
import sys


def _protocol_for(scope):
    for o in gc.get_objects():
        try:
            if isinstance(o, asyncio.Protocol) and getattr(getattr(o, "cycle", None), "scope", None) is scope:
                return f"{type(o).__module__}.{type(o).__qualname__}"
        except Exception:
            continue
    return "unknown"


async def app(scope, receive, send):
    if scope["type"] != "http":
        return
    loop = asyncio.get_running_loop()
    print(f"TRIPCURVE-PROTOCOL {_protocol_for(scope)} loop={type(loop).__module__}.{type(loop).__qualname__}",
          file=sys.stderr, flush=True)
    await send({"type": "http.response.start", "status": 200,
                "headers": [(b"content-length", b"2")]})
    await send({"type": "http.response.body", "body": b"ok"})
