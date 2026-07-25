#!/usr/bin/env python3
"""SPARQL Scope server — static app + read-only SPARQL proxy.

Stdlib only. Serves the web app and forwards SPARQL *queries* (never updates)
to endpoints the browser cannot reach directly: no CORS headers, a
docker-internal hostname, or an endpoint needing server-side credentials.

Env:
    SCOPE_PORT        listen port (default 8080)
    SCOPE_CONFIG      path to a connections JSON served at /config.json
                      (default: web/config.default.json)
    SCOPE_ALLOW       comma-separated host[:port] values; when set, only these
                      hosts may be proxied. STRONGLY recommended whenever
                      Scope is reachable by anyone you do not trust — an open
                      proxy can be aimed at internal services.
    SCOPE_AUTH_<NAME> "user:pass" sent as basic auth when the proxied
                      endpoint's HOST matches <NAME> (see auth_matches).
    SCOPE_MAX_BYTES   cap on a proxied response (default 25_000_000)
    SCOPE_TIMEOUT     upstream timeout in seconds (default 90)
    SCOPE_ALLOW_SERVICE  set to 1 to permit SPARQL federation (SERVICE). Off by
                      default: SERVICE makes the *endpoint* fetch a URL of the
                      query author's choosing, which SCOPE_ALLOW cannot police.
"""

import base64
import json
import os
import re
import urllib.error
import urllib.parse
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

ROOT = Path(__file__).resolve().parent
WEB = (ROOT / "web").resolve()
PORT = int(os.environ.get("SCOPE_PORT", "8080"))
CONFIG = Path(os.environ.get("SCOPE_CONFIG", str(WEB / "config.default.json")))
ALLOW = [s.strip().lower() for s in os.environ.get("SCOPE_ALLOW", "").split(",") if s.strip()]
MAX_BYTES = int(os.environ.get("SCOPE_MAX_BYTES", "25000000"))
ALLOW_SERVICE = os.environ.get("SCOPE_ALLOW_SERVICE", "").strip().lower() in ("1", "true", "yes")
TIMEOUT = int(os.environ.get("SCOPE_TIMEOUT", "90"))
VERSION = "0.1.0"

MIME = {".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8",
        ".css": "text/css; charset=utf-8", ".json": "application/json; charset=utf-8",
        ".svg": "image/svg+xml", ".png": "image/png", ".ico": "image/x-icon"}

# Content types we will echo back to the browser. Anything else is relabelled
# text/plain so a hostile endpoint cannot get HTML rendered on our origin.
SAFE_CTYPES = ("application/sparql-results+json", "application/json", "application/n-triples",
               "text/plain", "text/turtle", "application/rdf+xml", "application/ld+json",
               "application/sparql-results+xml", "text/csv", "text/tab-separated-values")

READ_FORMS = {"SELECT", "CONSTRUCT", "ASK", "DESCRIBE"}
UPDATE_FORMS = {"INSERT", "DELETE", "LOAD", "CLEAR", "DROP", "CREATE",
                "WITH", "COPY", "MOVE", "ADD"}

_PREFIX_DECL = re.compile(r'^PREFIX\s+[^\s:<>"{}|^`\\]*:\s*<[^<>"{}|^`\\]*>', re.I)
_BASE_DECL = re.compile(r'^BASE\s*<[^<>"{}|^`\\]*>', re.I)


def strip_comments(q: str) -> str:
    """Remove SPARQL comments while respecting IRIs and string literals —
    a '#' inside <http://…/ns#> or "a # b" is data, not a comment."""
    out, i, n = [], 0, len(q)
    while i < n:
        c = q[i]
        if c == "<":
            end, nl = q.find(">", i), q.find("\n", i)
            if end != -1 and (nl == -1 or end < nl):
                out.append(q[i:end + 1]); i = end + 1; continue
            out.append(c); i += 1; continue
        if c in "\"'":
            quote = c * 3 if q[i:i + 3] == c * 3 else c
            j = i + len(quote)
            while j < n:
                if q[j] == "\\":
                    j += 2; continue
                if q[j:j + len(quote)] == quote:
                    break
                j += 1
            stop = min(j + len(quote), n)
            out.append(q[i:stop]); i = stop; continue
        if c == "#":
            nl = q.find("\n", i)
            if nl == -1:
                break
            out.append("\n"); i = nl + 1; continue
        out.append(c); i += 1
    return "".join(out)


def query_kind(q: str) -> str:
    """Classify a SPARQL request by consuming the prologue exactly as the
    grammar defines it — Prologue ::= (BaseDecl | PrefixDecl)* — then reading
    the keyword that follows. A prefix *named* after a query form
    (`PREFIX select: <…> INSERT DATA …`) therefore cannot masquerade as that
    form, which is how a naive keyword scan lets an UPDATE through.

    MUST stay in lockstep with queryForm() in web/rdf.js — both are driven by
    test/queryform-fixtures.json. Unknown input fails closed.
    """
    s = strip_comments(q or "").lstrip("﻿")
    while True:
        before = s
        s = s.lstrip()
        m = _PREFIX_DECL.match(s) or _BASE_DECL.match(s)
        if m:
            s = s[m.end():]
            continue
        if s == before:
            break
    m = re.match(r"([A-Za-z]+)", s)
    if not m:
        return "UNKNOWN"
    kw = m.group(1).upper()
    return kw if kw in READ_FORMS or kw in UPDATE_FORMS else "UNKNOWN"


_IRI_RE = re.compile(r'<[^<>"{}|^`\\]*>')
_STR_RE = re.compile(r'"""[\s\S]*?"""|\'\'\'[\s\S]*?\'\'\'|"(?:[^"\\]|\\.)*"|\'(?:[^\'\\]|\\.)*\'')
_SERVICE_RE = re.compile(r'(^|[^?$:\w])SERVICE\b', re.I)


def uses_federation(q: str) -> bool:
    """Does the query use SPARQL federation (SERVICE)?

    A read-only query is still executed BY the endpoint: SERVICE makes the
    trusted store fetch a URL the query author chose, so SCOPE_ALLOW — which
    only vets the endpoint Scope talks to — cannot contain it. Refused unless
    SCOPE_ALLOW_SERVICE is set. Variables (?service) and prefixed names
    (ex:service) are not the keyword.
    """
    s = strip_comments(q or "")
    s = _IRI_RE.sub(" ", s)
    s = _STR_RE.sub(" ", s)
    return bool(_SERVICE_RE.search(s))


def _norm_host(s: str) -> str:
    return re.sub(r"[^a-z0-9]+", "_", (s or "").lower()).strip("_")


def auth_matches(name: str, endpoint: str) -> bool:
    """Do credentials registered as SCOPE_AUTH_<NAME> belong to this endpoint?

    Matched against the URL's HOST, never a substring of the whole URL: a
    substring test would ship credentials to `https://evil.com/?x=fuseki`.
    Non-alphanumerics are normalised on both sides so an env name like
    SCOPE_AUTH_MY_HOST_EXAMPLE_COM matches host my-host.example.com.
    """
    u = urllib.parse.urlparse(endpoint)
    target = _norm_host(name)
    if not target:
        return False
    return target in {_norm_host(u.hostname or ""), _norm_host(u.netloc or "")}


def endpoint_allowed(endpoint: str) -> bool:
    """SCOPE_ALLOW gate. Compares the host (optionally host:port), not a
    substring of the URL, so `https://evil.com/?x=fuseki` cannot slip past."""
    if not ALLOW:
        return True
    u = urllib.parse.urlparse(endpoint)
    host = (u.hostname or "").lower()
    netloc = (u.netloc or "").lower()
    return any(a == host or a == netloc for a in ALLOW)


def resolve_static(url_path: str):
    """Map a request path to a file under web/, or None. Percent-encoding is
    decoded BEFORE the containment check so %2e%2e%2f cannot escape."""
    raw = urllib.parse.unquote(urllib.parse.urlparse(url_path).path)
    if "\x00" in raw:
        return None
    candidate = (WEB / raw.lstrip("/")).resolve()
    if candidate != WEB and WEB not in candidate.parents:
        return None
    return candidate if candidate.is_file() else None


class NoRedirect(urllib.request.HTTPRedirectHandler):
    """Refuse redirects. urllib would turn a redirected POST into a body-less
    GET (silently losing the query), and a redirect could also send the
    request to a host SCOPE_ALLOW never approved."""

    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


OPENER = urllib.request.build_opener(NoRedirect)


class Handler(BaseHTTPRequestHandler):
    server_version = f"sparql-scope/{VERSION}"
    protocol_version = "HTTP/1.1"

    def log_message(self, fmt, *args):
        print(f"{self.address_string()} {fmt % args}")

    def _send(self, code, body: bytes, ctype="application/json; charset=utf-8"):
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("Referrer-Policy", "no-referrer")
        self.end_headers()
        self.wfile.write(body)

    def _err(self, code, msg):
        self._send(code, json.dumps({"error": msg}).encode())

    # ---------------- static
    def do_GET(self):
        path = urllib.parse.urlparse(self.path).path
        if path in ("/", "/index.html"):
            f = WEB / "index.html"
        elif path == "/config.json":
            if CONFIG.exists():
                return self._send(200, CONFIG.read_bytes())
            return self._send(200, b'{"connections": []}')
        elif path == "/health":
            return self._send(200, json.dumps({"ok": True, "version": VERSION}).encode())
        else:
            f = resolve_static(self.path)
            if f is None:
                return self._err(404, "not found")
        self._send(200, f.read_bytes(), MIME.get(f.suffix, "application/octet-stream"))

    # ---------------- read-only proxy
    def do_POST(self):
        if urllib.parse.urlparse(self.path).path != "/proxy":
            return self._err(404, "not found")
        try:
            n = int(self.headers.get("Content-Length", "0"))
            req = json.loads(self.rfile.read(n))
            endpoint, query = req["endpoint"], req["query"]
            accept = req.get("accept", "application/sparql-results+json")
            graphs = req.get("defaultGraphs", [])
            if not isinstance(graphs, list):
                graphs = []
        except (KeyError, ValueError, json.JSONDecodeError):
            return self._err(400, "body must be JSON: {endpoint, query, accept?, defaultGraphs?}")

        u = urllib.parse.urlparse(endpoint)
        if u.scheme not in ("http", "https"):
            return self._err(400, "endpoint must be http(s)")
        if not endpoint_allowed(endpoint):
            return self._err(403, "endpoint host is not in SCOPE_ALLOW")
        if not ALLOW_SERVICE and uses_federation(query):
            return self._err(403, "SPARQL federation (SERVICE) is disabled: it would make the "
                                  "endpoint fetch a URL of the query author's choosing, which "
                                  "SCOPE_ALLOW cannot police. Set SCOPE_ALLOW_SERVICE=1 to permit it.")
        kind = query_kind(query)
        if kind not in READ_FORMS:
            return self._err(403, f"read-only proxy: refused a {kind} request "
                                  "(only SELECT/CONSTRUCT/ASK/DESCRIBE are forwarded)")

        params = [("query", query)] + [("default-graph-uri", g) for g in graphs if isinstance(g, str)]
        body = urllib.parse.urlencode(params).encode()
        fwd = urllib.request.Request(endpoint, data=body, method="POST")
        fwd.add_header("Content-Type", "application/x-www-form-urlencoded")
        fwd.add_header("Accept", accept)
        # Wikidata and other public endpoints require a descriptive UA.
        fwd.add_header("User-Agent", os.environ.get(
            "SCOPE_USER_AGENT", f"SPARQL-Scope/{VERSION} (read-only graph explorer)"))
        for name, cred in os.environ.items():
            if name.startswith("SCOPE_AUTH_") and auth_matches(name[len("SCOPE_AUTH_"):], endpoint):
                fwd.add_header("Authorization",
                               "Basic " + base64.b64encode(cred.encode()).decode())
                break
        try:
            with OPENER.open(fwd, timeout=TIMEOUT) as r:
                payload = r.read(MAX_BYTES + 1)
                if len(payload) > MAX_BYTES:
                    return self._err(502, f"response exceeded SCOPE_MAX_BYTES ({MAX_BYTES}); "
                                          "add a LIMIT to the query")
                ctype = r.headers.get("Content-Type", accept)
                if not any(ctype.lower().startswith(c) for c in SAFE_CTYPES):
                    ctype = "text/plain; charset=utf-8"
                self._send(200, payload, ctype)
        except urllib.error.HTTPError as e:
            detail = e.read(20000)
            if e.code in (301, 302, 303, 307, 308):
                loc = e.headers.get("Location", "?")
                return self._err(502, f"endpoint redirected to {loc} — Scope does not follow "
                                      "redirects (it would drop the query and could bypass "
                                      "SCOPE_ALLOW). Configure the final URL instead.")
            self._send(e.code, detail or str(e).encode(), "text/plain; charset=utf-8")
        except Exception as exc:  # noqa: BLE001 — surface network errors to the UI
            self._err(502, f"proxy fetch failed: {exc}")


if __name__ == "__main__":
    print(f"sparql-scope {VERSION} on :{PORT} (config: {CONFIG}"
          f"{', SCOPE_ALLOW=' + ','.join(ALLOW) if ALLOW else ', proxy OPEN — set SCOPE_ALLOW if untrusted users can reach this'})")
    ThreadingHTTPServer(("0.0.0.0", PORT), Handler).serve_forever()
