# Smallest WSGI app for the gunicorn worker-model measurements: 200 "ok"
# with a Content-Length.
def app(environ, start_response):
    start_response("200 OK", [("Content-Length", "2")])
    return [b"ok"]
