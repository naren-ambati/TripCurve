# WSGI app with a slow endpoint for the B4 shutdown measurements.
# GET /sleep?s=N : touch <TC_MARKER_DIR>/started (so the runner knows the
# request is in flight), sleep N seconds, then answer 200 "done".
import os
import time
from urllib.parse import parse_qs


def app(environ, start_response):
    secs = float(parse_qs(environ.get("QUERY_STRING", "")).get("s", ["0"])[0])
    marker = os.environ.get("TC_MARKER_DIR")
    if marker:
        open(os.path.join(marker, "started"), "w").close()
    time.sleep(secs)
    start_response("200 OK", [("Content-Length", "4")])
    return [b"done"]
