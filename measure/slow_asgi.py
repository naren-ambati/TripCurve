# ASGI app with a slow endpoint for the B4 shutdown measurements.
# GET /sleep?s=N : touch <TC_MARKER_DIR>/started, sleep N seconds, 200 "done".
import asyncio
import os
from urllib.parse import parse_qs


async def app(scope, receive, send):
    if scope["type"] != "http":
        return
    secs = float(parse_qs(scope.get("query_string", b"").decode()).get("s", ["0"])[0])
    marker = os.environ.get("TC_MARKER_DIR")
    if marker:
        open(os.path.join(marker, "started"), "w").close()
    await asyncio.sleep(secs)
    await send({"type": "http.response.start", "status": 200, "headers": [(b"content-length", b"4")]})
    await send({"type": "http.response.body", "body": b"done"})
