#!/usr/bin/env python3
"""Server-side tests — run: python3 test/test_server.py

The read-only gate exists in two places (browser + proxy). They are driven by
the same fixture file so they cannot drift apart: a bypass that works on one
and not the other is exactly how an UPDATE reaches an endpoint.
"""
import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))
import server  # noqa: E402

FIXTURES = json.loads((ROOT / "test" / "queryform-fixtures.json").read_text())["cases"]

passed = failed = 0


def check(name, cond, detail=""):
    global passed, failed
    if cond:
        passed += 1
        print(f"  ok   {name}")
    else:
        failed += 1
        print(f"  FAIL {name}\n         {detail}")


print("read-only gate (shared fixtures):")
for c in FIXTURES:
    got = server.query_kind(c["query"])
    check(c["why"], got == c["form"], f"expected {c['form']}, got {got} for {c['query']!r}")
    ro = got in server.READ_FORMS
    check(f"  ↳ readonly={c['readonly']}", ro == c["readonly"],
          f"expected readonly={c['readonly']}, got {ro}")

print("\nauth-header targeting (credentials must not follow a hostile endpoint):")
check("substring match cannot be abused by a lookalike host",
      not server.auth_matches("fuseki", "https://evil.com/?x=fuseki"),
      "an attacker-supplied endpoint whose URL merely CONTAINS the name must not receive credentials")
check("credentials bind to the real host",
      server.auth_matches("fuseki", "http://fuseki:3030/ds/sparql"))
check("host match is case-insensitive",
      server.auth_matches("FUSEKI", "http://Fuseki:3030/ds/sparql"))
check("different host with same suffix is not matched",
      not server.auth_matches("fuseki", "http://evil-fuseki.com/sparql"))
check("port-qualified host names match",
      server.auth_matches("fuseki:3030", "http://fuseki:3030/ds/sparql"))

print("\nSPARQL federation guard (SSRF via the endpoint):")
for q in ["SELECT * WHERE { SERVICE <http://evil/> { ?s ?p ?o } }",
          "SELECT * { service <http://evil/> { ?s ?p ?o } }",
          "SELECT * WHERE { SERVICE SILENT <http://evil/> { ?s ?p ?o } }"]:
    check(f"detects {q[:44]}", server.uses_federation(q))
for q in ["SELECT * WHERE { ?s ?p ?o }",
          "SELECT ?service WHERE { ?s ?p ?service }",
          'PREFIX ex: <http://x#> SELECT * WHERE { ?s ex:service ?o }',
          'SELECT * WHERE { ?s ?p "SERVICE" }',
          "# SERVICE\nSELECT * WHERE { ?s ?p ?o }",
          "SELECT * WHERE { <http://a/SERVICE> ?p ?o }"]:
    check(f"no false positive: {q[:40]}", not server.uses_federation(q))

print("\nstatic path safety:")
for bad in ["/../server.py", "/..%2fserver.py", "//etc/passwd", "/web/../../server.py"]:
    check(f"rejects {bad}", server.resolve_static(bad) is None)
for good in ["/app.js", "/style.css", "/vendor/cytoscape.min.js"]:
    check(f"serves {good}", server.resolve_static(good) is not None)

print(f"\n{passed} passed, {failed} failed")
sys.exit(1 if failed else 0)
