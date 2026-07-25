/* Unit tests for web/rdf.js — run: ./test/run.sh  (node, no dependencies)
 *
 * Every case below encodes a defect found by adversarial review of v0.1.
 * They exist so the read-only gate and the N-Triples parser cannot silently
 * regress: both are places where being wrong is worse than being broken. */
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import path from "node:path";

const require = createRequire(import.meta.url);
const R = require(path.join(path.dirname(fileURLToPath(import.meta.url)), "../web/rdf.js"));

let pass = 0, fail = 0;
const results = [];
function t(name, fn) {
  try { fn(); pass++; results.push(`  ok   ${name}`); }
  catch (e) { fail++; results.push(`  FAIL ${name}\n         ${e.message}`); }
}
function eq(actual, expected, msg = "") {
  const a = JSON.stringify(actual), b = JSON.stringify(expected);
  if (a !== b) throw new Error(`${msg}\n         expected: ${b}\n         actual:   ${a}`);
}
const ok = (v, msg) => { if (!v) throw new Error(msg || "expected truthy"); };

/* ---- shared contract: the browser gate and the proxy gate must agree ---- */
const FIXTURES = require(path.join(path.dirname(fileURLToPath(import.meta.url)),
                                   "queryform-fixtures.json")).cases;
t(`read-only gate matches shared fixtures (${FIXTURES.length} cases, same file drives server.py)`, () => {
  for (const c of FIXTURES) {
    eq(R.queryForm(c.query), c.form, `form for: ${JSON.stringify(c.query)} — ${c.why}`);
    eq(R.isReadOnlyForm(c.query), c.readonly, `readonly for: ${JSON.stringify(c.query)} — ${c.why}`);
  }
});

/* ------------------------------------------- query form / read-only gate */
t("PREFIX named after a form cannot masquerade as it (v0.1 blocker)", () => {
  eq(R.queryForm('PREFIX select: <http://x#> INSERT DATA { <a> <b> <c> }'), "INSERT");
  eq(R.isReadOnlyForm('PREFIX select: <http://x#> INSERT DATA { <a> <b> <c> }'), false);
  eq(R.queryForm('PREFIX construct: <http://x#> DELETE WHERE { ?s ?p ?o }'), "DELETE");
  eq(R.queryForm('PREFIX describe: <http://x#> PREFIX ask: <http://y#> LOAD <http://z>'), "LOAD");
});
t("'#' inside an IRI is not a comment", () => {
  eq(R.queryForm('PREFIX eli: <http://data.europa.eu/eli/ontology#> SELECT * WHERE { ?s ?p ?o }'), "SELECT");
});
t("comment cannot disguise an update", () => {
  eq(R.queryForm("# SELECT nothing\nINSERT DATA { <http://a> <http://b> 1 }"), "INSERT");
  eq(R.queryForm("#SELECT\n#CONSTRUCT\nDROP GRAPH <http://g>"), "DROP");
});
t("update keyword inside a literal does not make a read query an update", () => {
  eq(R.queryForm('SELECT ?s WHERE { ?s <http://p> "DELETE me" } LIMIT 1'), "SELECT");
  eq(R.isReadOnlyForm('SELECT ?s WHERE { ?s <http://p> "INSERT DATA { }" }'), true);
});
t("WITH-form and other update keywords are refused", () => {
  for (const q of ["WITH <http://g> DELETE { ?s ?p ?o } WHERE { ?s ?p ?o }",
                   "CLEAR GRAPH <http://g>", "COPY <http://a> TO <http://b>",
                   "MOVE DEFAULT TO <http://b>", "ADD <http://a> TO <http://b>",
                   "CREATE GRAPH <http://g>", "LOAD <http://data> INTO GRAPH <http://g>"])
    eq(R.isReadOnlyForm(q), false, `must refuse: ${q}`);
});
t("legitimate read queries are allowed", () => {
  for (const [q, form] of [
    ["SELECT * WHERE { ?s ?p ?o }", "SELECT"],
    ["  \n\t CONSTRUCT { ?s ?p ?o } WHERE { ?s ?p ?o }", "CONSTRUCT"],
    ["ASK { ?s ?p ?o }", "ASK"],
    ["DESCRIBE <http://example.org/x>", "DESCRIBE"],
    ["BASE <http://x/> PREFIX p: <http://y#> SELECT * WHERE { ?s ?p ?o }", "SELECT"],
    ["﻿SELECT * WHERE { ?s ?p ?o }", "SELECT"],
  ]) { eq(R.queryForm(q), form, q); eq(R.isReadOnlyForm(q), true, q); }
});
t("unknown / empty input fails closed", () => {
  eq(R.isReadOnlyForm(""), false);
  eq(R.isReadOnlyForm("gibberish"), false);
  eq(R.isReadOnlyForm(null), false);
});

t("SPARQL federation is detected without false positives (SSRF via the endpoint)", () => {
  for (const q of ["SELECT * WHERE { SERVICE <http://evil/> { ?s ?p ?o } }",
                   "SELECT * { service <http://evil/> { ?s ?p ?o } }",
                   "SELECT * WHERE { SERVICE SILENT <http://evil/> { ?s ?p ?o } }"])
    ok(R.usesFederation(q), `must detect: ${q}`);
  for (const q of ["SELECT * WHERE { ?s ?p ?o }",
                   "SELECT ?service WHERE { ?s ?p ?service }",
                   'PREFIX ex: <http://x#> SELECT * WHERE { ?s ex:service ?o }',
                   'SELECT * WHERE { ?s ?p "SERVICE" }',
                   "# SERVICE\nSELECT * WHERE { ?s ?p ?o }",
                   "SELECT * WHERE { <http://a/SERVICE> ?p ?o }"])
    ok(!R.usesFederation(q), `must NOT flag: ${q}`);
});

/* --------------------------------------------------------- IRI safety */
t("IRIs that would break out of <…> are rejected (injection blocker)", () => {
  ok(!R.isSafeIri("http://evil/> } ; DROP ALL ; SELECT * { <a"), "must reject '>' breakout");
  ok(!R.isSafeIri("http://evil/ x"), "must reject space");
  ok(!R.isSafeIri("http://evil/\nDROP ALL"), "must reject newline");
  ok(!R.isSafeIri('http://evil/"'), "must reject quote");
  ok(!R.isSafeIri("http://evil/{x}"), "must reject braces");
  ok(!R.isSafeIri(""), "must reject empty");
  ok(R.isSafeIri("https://example.org/act/regulation/2022/8"), "normal IRI ok");
  ok(R.isSafeIri("http://www.wikidata.org/entity/Q810"), "wikidata IRI ok");
  let threw = false;
  try { R.iriRef("http://evil/> } ; SELECT * {"); } catch { threw = true; }
  ok(threw, "iriRef must throw rather than emit an injectable string");
  eq(R.iriRef("http://a/b"), "<http://a/b>");
});

/* ------------------------------------------------------ N-Triples parse */
const NT = (s) => R.parseNTriples(s);
t("blank nodes are preserved as subject and object (v0.1 dropped them)", () => {
  const r = NT('_:b0 <http://p> <http://o> .\n<http://s> <http://p> _:b1 .');
  eq(r.triples.length, 2);
  eq(r.triples[0].s, "_:b0");
  eq(r.triples[0].sType, "bnode");
  eq(r.triples[1].o, { type: "bnode", value: "_:b1" });
});
t("8-digit \\U escapes parse instead of throwing away the whole result", () => {
  const r = NT('<http://s> <http://p> "grinning \\U0001F600 face" .');
  eq(r.errors, []);
  eq(r.triples[0].o.value, "grinning \u{1F600} face");
});
t("4-digit \\u, escaped quote/backslash/newline/tab all decode", () => {
  const r = NT('<http://s> <http://p> "q=\\"x\\" b=\\\\ n=\\n t=\\t u=\\u0645" .');
  eq(r.errors, []);
  eq(r.triples[0].o.value, 'q="x" b=\\ n=\n t=\t u=م');
});
t("language tags with subtags, and typed literals", () => {
  const r = NT('<http://s> <http://p> "الأردن"@ar-JO .\n' +
               '<http://s> <http://p2> "42"^^<http://www.w3.org/2001/XMLSchema#integer> .');
  eq(r.triples[0].o.lang, "ar-JO");
  eq(r.triples[0].o.value, "الأردن");
  eq(r.triples[1].o.datatype, "http://www.w3.org/2001/XMLSchema#integer");
});
t("UCHAR escapes inside IRIs are decoded (wrong node identity otherwise)", () => {
  const r = NT('<http://s/\\u00E9> <http://p> <http://o> .');
  eq(r.triples[0].s, "http://s/é");
});
t("literals containing ' . ' and '>' do not corrupt parsing", () => {
  const r = NT('<http://s> <http://p> "a . b > c" .');
  eq(r.errors, []);
  eq(r.triples[0].o.value, "a . b > c");
});
t("CRLF endings and comment lines are handled", () => {
  const r = NT('# a comment\r\n<http://s> <http://p> <http://o> .\r\n\r\n');
  eq(r.triples.length, 1);
});
t("one malformed line does not discard the whole response", () => {
  const r = NT('<http://s> <http://p> <http://o> .\nthis is not n-triples\n<http://s2> <http://p> <http://o2> .');
  eq(r.triples.length, 2, "valid triples must survive");
  eq(r.errors.length, 1, "the bad line must be reported, not silently dropped");
});
t("real store output (typed IRIs + RTL literal) parses completely", () => {
  const real = [
    '<https://example.org/act/regulation/2022/8> <http://data.europa.eu/eli/ontology#amended_by> <https://example.org/act/regulation/2022/15> .',
    '<https://example.org/act/regulation/2022/8> <http://purl.org/dc/terms/title> "نظام المشتريات"@ar .',
  ].join("\n");
  const r = NT(real);
  eq(r.errors, []);
  eq(r.triples.length, 2);
  eq(r.triples[1].o.lang, "ar");
});

/* ------------------------------------------------------------- helpers */
t("localName never throws on a bare '%' (render callback safety)", () => {
  eq(R.localNameWith({}, "http://example.org/100%pure"), "100%pure");
  eq(R.localNameWith({}, "http://example.org/caf%C3%A9"), "café");
});
t("prefix compaction picks the longest matching namespace", () => {
  const p = { ex: "http://example.org/", exSub: "http://example.org/sub/" };
  eq(R.compactWith(p, "http://example.org/sub/x"), "exSub:x");
  eq(R.compactWith(p, "http://example.org/y"), "ex:y");
  eq(R.compactWith(p, "http://other/z"), "http://other/z");
});
t("auto-LIMIT does not duplicate or corrupt queries", () => {
  eq(R.withLimit("SELECT * WHERE { ?s ?p ?o } LIMIT 10", 200), "SELECT * WHERE { ?s ?p ?o } LIMIT 10");
  ok(R.withLimit("SELECT * WHERE { ?s ?p ?o }", 200).includes("LIMIT 200"), "should append");
  const withComment = R.withLimit("SELECT * WHERE { ?s ?p ?o } # trailing note", 200);
  ok(/LIMIT 200\s*$/.test(withComment), "LIMIT must not land inside a trailing comment");
  eq(R.withLimit("INSERT DATA { <a> <b> <c> }", 200), "INSERT DATA { <a> <b> <c> }", "never touch updates");
  const values = R.withLimit('SELECT ?x WHERE { VALUES ?x { <http://a> <http://b> } }', 200);
  ok(values.includes("LIMIT 200"), "VALUES query should still get a limit after its closing brace");
});

console.log(results.join("\n"));
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
