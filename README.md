# 🔭 SPARQL Scope

**A read-only graph explorer for any SPARQL 1.1 endpoint** — the "graph browser"
experience for RDF: run a query, see a graph, click a node for its metadata,
double-click to expand its neighbourhood.

- **Any endpoint.** Wikidata, DBpedia, your Fuseki/GraphDB/Virtuoso/Oxigraph —
  anything speaking the SPARQL 1.1 Protocol. Endpoints without CORS (or on
  docker-internal hostnames) work through the built-in read-only proxy.
- **Query-first.** `CONSTRUCT`/`DESCRIBE` render as a graph; `SELECT` renders as
  a table, with a graph view offered when the rows really are triple-shaped;
  `ASK` answers directly. SPARQL editor with syntax highlighting, history and
  per-connection sample queries. `Ctrl+Enter` runs.
- **Node interactions.** Click → detail panel: label, types, every literal
  property, and in/out relationship counts grouped by predicate — each one a
  button that expands exactly that relationship set. Double-click → bounded
  neighbourhood expand, so a hub node cannot explode the canvas.
- **Multilingual & RTL-correct.** Labels follow your language preference
  (`"lang": "ar,en"`); Arabic and other RTL scripts shape and align correctly
  because everything renders through the browser's own text stack.
- **Read-only by design.** SPARQL UPDATE is refused by the browser *and* by the
  proxy. Classification consumes the SPARQL prologue per the grammar, so a
  prefix named after a query form (`PREFIX select: <…> INSERT DATA …`) cannot
  masquerade as a read query. Both gates are driven by the same fixture file so
  they cannot drift apart.
- **Self-contained.** One small container (Python standard library only, plus
  vendored pinned front-end libraries). It makes **no third-party network
  requests** — the bundled editor's prefix.cc autocomplete is deliberately
  disabled — so it works on an isolated or offline LAN.

## Run

```bash
docker compose up -d          # → http://localhost:8080
```

or without Docker: `python3 server.py` (no dependencies, Python 3.9+).

It ships with a Wikidata connection — open the app, pick a sample query, run.

## Preloading connections

Mount a config file and point `SCOPE_CONFIG` at it. Clone this repo first, since
the image is built locally:

```yaml
services:
  sparql-scope:
    build: .                 # or: build: https://github.com/imabedalghafer/sparql-registry-viewer.git
    image: sparql-scope:0.1.0
    ports: ["8080:8080"]
    volumes: ["./my-config.json:/config/config.json:ro"]
    environment:
      - SCOPE_CONFIG=/config/config.json
      - SCOPE_ALLOW=my-store:3030,query.wikidata.org
```

```jsonc
{
  "connections": [{
    "name": "My registry",
    "endpoint": "http://fuseki:3030/ds/sparql", // docker-internal → proxy mode
    "mode": "proxy",                            // or "direct" when the endpoint sends CORS headers
    "lang": "ar,en",                            // label language preference, best first
    "defaultGraphs": ["https://example.org/g"], // sent as default-graph-uri on every query
    "prefixes": { "ex": "https://example.org/ns#" },       // IRI shortening in the UI
    "classStyles": { "LegalResource": "#1baf7a" },         // type-IRI substring → node colour (longest match wins)
    "layerProperty": "https://example.org/ns#rank",        // numeric property → layered layout
    "defaultQuery": "SELECT …",                            // loaded when the connection is selected
    "samples": [{ "name": "…", "q": "…" }]
  }]
}
```

Users can also add connections in the UI; those are stored in the browser.

## Server environment

| Variable | Effect |
|---|---|
| `SCOPE_PORT` | listen port (default 8080) |
| `SCOPE_CONFIG` | path of the config JSON served to the app |
| `SCOPE_ALLOW` | comma-separated `host` or `host:port` values the proxy may query. **Set this whenever untrusted users can reach Scope** — see [SECURITY.md](SECURITY.md) |
| `SCOPE_AUTH_<NAME>` | `user:pass` sent as basic auth when the endpoint's *host* matches `<NAME>`; credentials never reach the browser |
| `SCOPE_MAX_BYTES` | cap on a proxied response (default 25 MB) |
| `SCOPE_TIMEOUT` | upstream timeout in seconds (default 90) |
| `SCOPE_ALLOW_SERVICE` | set to `1` to permit SPARQL federation (`SERVICE`). Off by default — `SERVICE` makes the *endpoint* fetch a URL chosen by the query, which `SCOPE_ALLOW` cannot police |
| `SCOPE_USER_AGENT` | override the outbound User-Agent (Wikidata's policy asks for a contact address) |

## Endpoint compatibility

Verified against Fuseki, Wikidata, DBpedia, UniProt and QLever. Honest caveats:

- **N-Triples only.** Graph rendering requests `application/n-triples`. An
  endpoint that ignores the `Accept` header and answers in Turtle or RDF/XML
  produces an explicit error rather than an empty canvas.
- **Redirects are not followed.** A redirected POST would silently become a
  body-less GET (losing the query) and could reach a host `SCOPE_ALLOW` never
  approved. Scope reports the `Location` so you can configure the final URL —
  e.g. use `https://dbpedia.org/sparql`, not `http://`.
- **`GRAPH ?g` is not universal.** The "graphs" button returns nothing on stores
  that do not expose named graphs (Wikidata among them). When a connection pins
  `defaultGraphs`, graph listing deliberately ignores it — pinning a default
  graph empties the named-graph set, so the listing would always be zero.
- **SPARQL federation (`SERVICE`) is refused by default** — see the env table.
- **Blank nodes** are shown (as diamonds) but cannot be expanded: SPARQL has no
  way to address another document's blank node.
- Unbounded `SELECT`/`CONSTRUCT` get `LIMIT 200` appended unless you switch
  auto-LIMIT off. Expansions are bounded per click.
- Up to 8 `rdf:type`s get distinct palette colours (`classStyles` overrides
  this); further types render neutral.

## Development

```bash
./test/run.sh              # front-end unit tests (node, or docker if node is absent)
python3 test/test_server.py # server tests: read-only gate, auth targeting, path safety
```

`test/queryform-fixtures.json` is the shared contract for the read-only gate:
both `web/rdf.js` (browser) and `server.py` (proxy) are tested against it, so a
bypass cannot exist on one side only.

## License

Copyright 2026 Ibrahim Abedalghafer. Licensed under Apache-2.0 — see
[LICENSE](LICENSE). Bundled third-party libraries and their MIT notices are
listed in [THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md).
