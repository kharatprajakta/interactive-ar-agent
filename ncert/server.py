"""NCERT search service (stdlib HTTP over ChromaDB), auto-started by server.js.

GET  /health   -> {"ok": true, "chunks": N}
GET  /catalog  -> {"10": {"science": [{"chapter": 1, "title": "..."}]}}
POST /search   {"class_num": 10, "subject": "science", "query": "...", "k": 5, "chapter": null}
"""
import json
import os
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

from . import store

HOST = os.environ.get("NCERT_HOST", "127.0.0.1")
PORT = int(os.environ.get("NCERT_PORT", "5006"))
_lock = threading.Lock()
_catalog = {"at": 0.0, "data": None}


def cached_catalog():
    # The catalog scan touches every chunk's metadata, so cache it briefly.
    if _catalog["data"] is None or time.time() - _catalog["at"] > 60:
        with _lock:
            _catalog["data"], _catalog["at"] = store.catalog(), time.time()
    return _catalog["data"]


class Handler(BaseHTTPRequestHandler):
    def _json(self, status, data):
        body = json.dumps(data).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        if self.path == "/health":
            self._json(200, {"ok": True, "chunks": store.total_chunks()})
        elif self.path == "/catalog":
            self._json(200, cached_catalog())
        else:
            self._json(404, {"error": "not found"})

    def do_POST(self):
        if self.path != "/search":
            return self._json(404, {"error": "not found"})
        try:
            body = json.loads(self.rfile.read(int(self.headers.get("Content-Length", 0))) or b"{}")
            results = store.search(
                str(body["query"])[:1000],
                int(body["class_num"]),
                str(body["subject"]).lower(),
                k=min(int(body.get("k", 5)), 10),
                chapter=int(body["chapter"]) if body.get("chapter") else None,
            )
            self._json(200, {"results": results})
        except (KeyError, ValueError, TypeError) as err:
            self._json(400, {"error": f"bad request: {err}"})
        except Exception as err:
            self._json(500, {"error": str(err)})

    def log_message(self, *args):
        pass


if __name__ == "__main__":
    print(f"[ncert] {store.total_chunks()} chunks indexed; ready on http://{HOST}:{PORT}", flush=True)
    ThreadingHTTPServer((HOST, PORT), Handler).serve_forever()
