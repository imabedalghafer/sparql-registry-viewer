# Contributing

Thanks for taking a look. SPARQL Scope is deliberately small: a Python
standard-library server and vanilla JavaScript, with no build step.

## Run it

```bash
python3 server.py        # → http://localhost:8080
```

Edit files under `web/` and reload; nothing needs compiling.

## Tests — please keep them green

```bash
./test/run.sh               # front-end unit tests (node, or docker if node is absent)
python3 test/test_server.py # server: read-only gate, federation guard, auth targeting, path safety
```

Two rules matter more than style here:

1. **The read-only gate lives in two places** — `web/rdf.js` (browser) and
   `server.py` (proxy) — and they are driven by the same fixture file,
   `test/queryform-fixtures.json`. If you touch either gate, add the case to
   the fixtures so both are tested. A bypass that exists on one side only is
   how the original hole got in.
2. **Data from an endpoint is untrusted.** It reaches the DOM through
   `textContent` only (never `innerHTML`), and any IRI going into a query must
   pass `ScopeRDF.iriRef()` first. Please keep both properties.

## Re-vendoring the front-end libraries

Libraries are committed under `web/vendor/` so the container makes no network
requests at runtime. To update one:

```bash
curl -sfL -o web/vendor/cytoscape.min.js \
  https://cdn.jsdelivr.net/npm/cytoscape@<version>/dist/cytoscape.min.js
```

Then update the version in `THIRD-PARTY-NOTICES.md` (and its license, if it
changed). After updating YASQE, re-check that it still makes no outbound
requests: it ships an autocompleter that fetches prefix.cc and a `Ctrl-Enter`
binding that POSTs to dbpedia.org, both disabled explicitly in
`initEditor()` — an upgrade can reintroduce them.

## Scope of the project

It is an *explorer*, not an editor: SPARQL UPDATE is out of scope by design.
Bug reports that come with a failing test case are the most useful kind.
Security issues: please see [SECURITY.md](SECURITY.md) rather than opening a
public issue.
