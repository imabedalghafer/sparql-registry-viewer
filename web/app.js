/* SPARQL Registry Viewer — read-only graph explorer for any SPARQL 1.1 endpoint.
 * Copyright 2026 Ibrahim Abedalghafer. SPDX-License-Identifier: Apache-2.0
 *
 * Data from an endpoint is untrusted: it reaches the DOM only via textContent,
 * and IRIs are validated (ScopeRDF.iriRef) before entering a query. Parsing and
 * the read-only gate live in rdf.js, which is unit-tested.
 */
"use strict";

const R = window.ScopeRDF;
const $ = (id) => document.getElementById(id);
const el = (tag, cls, text) => {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text !== undefined) { n.textContent = text; n.setAttribute("dir", "auto"); }
  return n;
};

const BASE_PREFIXES = {
  rdf: "http://www.w3.org/1999/02/22-rdf-syntax-ns#",
  rdfs: "http://www.w3.org/2000/01/rdf-schema#",
  owl: "http://www.w3.org/2002/07/owl#",
  xsd: "http://www.w3.org/2001/XMLSchema#",
  skos: "http://www.w3.org/2004/02/skos/core#",
  dcterms: "http://purl.org/dc/terms/",
  foaf: "http://xmlns.com/foaf/0.1/",
  prov: "http://www.w3.org/ns/prov#",
  schema: "http://schema.org/",
  wd: "http://www.wikidata.org/entity/",
  wdt: "http://www.wikidata.org/prop/direct/",
  eli: "http://data.europa.eu/eli/ontology#",
};
let prefixes = { ...BASE_PREFIXES };
const compact = (iri) => R.compactWith(prefixes, iri);
const localName = (iri) => R.localNameWith(prefixes, iri);

const DEFAULT_SAMPLES = [
  { name: "50 triples (graph)", q: "CONSTRUCT { ?s ?p ?o } WHERE { ?s ?p ?o } LIMIT 50" },
  { name: "classes by instance count", q: "SELECT ?class (COUNT(?x) AS ?n) WHERE { ?x a ?class } GROUP BY ?class ORDER BY DESC(?n) LIMIT 25" },
  { name: "properties in use", q: "SELECT ?p (COUNT(*) AS ?n) WHERE { ?s ?p ?o } GROUP BY ?p ORDER BY DESC(?n) LIMIT 25" },
];

let connections = [], conn = null, editor = null;
let lastSelect = null;      // { res, spo, vars } — powers the table⇄graph toggle
let stageMode = "empty";    // empty | graph | table

/* ---------------------------------------------------------------- config */
async function loadConfig() {
  let cfg = { connections: [] };
  try { cfg = await (await fetch("config.json")).json(); } catch { /* file:// use */ }
  let custom = [];
  try {
    const parsed = JSON.parse(localStorage.getItem("scopeConns") || "[]");
    if (Array.isArray(parsed)) custom = parsed.filter((c) => c && typeof c.endpoint === "string");
  } catch {
    localStorage.removeItem("scopeConns"); // corrupt storage must never brick boot
  }
  connections = [...(cfg.connections || []), ...custom].filter((c) => c && c.endpoint);
  if (!connections.length)
    connections = [{ name: "Wikidata", endpoint: "https://query.wikidata.org/sparql", mode: "direct", lang: "en" }];

  const sel = $("connSelect");
  sel.replaceChildren(...connections.map((c, i) => {
    const o = el("option", null, c.name || c.endpoint); o.value = String(i); return o;
  }));
  let idx = parseInt(localStorage.getItem("scopeConnIdx") || "0", 10);
  if (!Number.isInteger(idx) || idx < 0 || idx >= connections.length) idx = 0;
  sel.value = String(idx);
  setConn(connections[idx]);
}

function setConn(c) {
  conn = c;
  prefixes = { ...BASE_PREFIXES };
  if (c.prefixes && typeof c.prefixes === "object")
    for (const [k, v] of Object.entries(c.prefixes))
      if (typeof v === "string" && k !== "__proto__") prefixes[k] = v;
  $("connStatus").textContent = `${c.endpoint} · ${c.mode === "proxy" ? "via proxy" : "direct"}`;
  $("connStatus").title = c.mode === "proxy"
    ? "Queries go through the viewer's server (works for endpoints without CORS)"
    : "Your browser queries the endpoint directly";

  const ph = (label) => { const o = el("option", null, label); o.value = ""; return o; };
  let hist = [];
  try { const h = JSON.parse(localStorage.getItem(`scopeHist:${c.name}`) || "[]"); if (Array.isArray(h)) hist = h; } catch { /* ignore */ }
  $("history").replaceChildren(ph("history…"),
    ...hist.map((q) => { const o = el("option", null, q.replace(/\s+/g, " ").slice(0, 80)); o.value = q; return o; }));
  const samples = [...(Array.isArray(c.samples) ? c.samples : []), ...DEFAULT_SAMPLES];
  $("samples").replaceChildren(ph("samples…"),
    ...samples.map((s) => { const o = el("option", null, s.name); o.value = s.q; return o; }));

  clearGraph();
  if (c.defaultQuery && editor) editor.setValue(c.defaultQuery);
}

/* -------------------------------------------------------------- protocol */
async function sparql(query, accept, { withDefaultGraphs = true } = {}) {
  const graphs = (withDefaultGraphs && Array.isArray(conn.defaultGraphs)) ? conn.defaultGraphs : [];
  let body, ctype;
  if (conn.mode === "proxy") {
    const r = await fetch("proxy", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ endpoint: conn.endpoint, query, accept, defaultGraphs: graphs }),
    });
    body = await r.text();
    ctype = r.headers.get("Content-Type") || "";
    if (!r.ok) throw new Error(friendlyError(r.status, body));
  } else {
    const form = new URLSearchParams({ query });
    for (const g of graphs) form.append("default-graph-uri", g);
    const r = await fetch(conn.endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: accept },
      body: form,
    });
    body = await r.text();
    ctype = r.headers.get("Content-Type") || "";
    if (!r.ok) throw new Error(friendlyError(r.status, body));
  }
  return { body, ctype };
}

function friendlyError(status, body) {
  let msg = body;
  try { const j = JSON.parse(body); if (j.error) msg = j.error; } catch { /* plain text */ }
  return `HTTP ${status}: ${String(msg).replace(/\s+/g, " ").slice(0, 500)}`;
}

async function sparqlJSON(query, opts) {
  const { body, ctype } = await sparql(query, "application/sparql-results+json", opts);
  if (/text\/html/i.test(ctype))
    throw new Error("endpoint returned HTML, not SPARQL results — is this really a SPARQL endpoint (or is it behind a login page)?");
  try { return JSON.parse(body); }
  catch { throw new Error(`endpoint returned ${ctype || "an unrecognised type"} instead of SPARQL JSON results`); }
}

async function sparqlTriples(query, opts) {
  const { body, ctype } = await sparql(query, "application/n-triples", opts);
  if (/text\/html/i.test(ctype))
    throw new Error("endpoint returned HTML, not RDF — is this really a SPARQL endpoint?");
  const parsed = R.parseNTriples(body);
  if (!parsed.triples.length && /turtle|rdf\+xml|json/i.test(ctype) && body.trim())
    throw new Error(`endpoint ignored our Accept header and returned ${ctype}; SPARQL Registry Viewer v0.1 parses N-Triples only`);
  return parsed;
}

/* --------------------------------------------------------------- palette */
const PALETTE_LIGHT = ["#2a78d6", "#eb6834", "#1baf7a", "#eda100", "#e87ba4", "#008300", "#4a3aa7", "#e34948"];
const PALETTE_DARK = ["#3987e5", "#d95926", "#199e70", "#c98500", "#d55181", "#008300", "#9085e9", "#e66767"];
const typeSlots = new Map();
const cssVar = (n) => getComputedStyle(document.documentElement).getPropertyValue(n).trim();
const isDark = () => (document.documentElement.dataset.theme ||
  (matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light")) === "dark";

/** Deterministic: an explicit classStyles match wins, otherwise a stable slot. */
function typeColor(typeIri) {
  if (!typeIri) return cssVar("--muted");
  const styles = (conn && conn.classStyles) || {};
  let best = null;
  for (const [match, color] of Object.entries(styles))
    if (typeof color === "string" && typeIri.includes(match) && (!best || match.length > best[0].length))
      best = [match, color];
  if (best) return best[1];
  if (!typeSlots.has(typeIri)) {
    if (typeSlots.size >= 8) return cssVar("--muted");
    typeSlots.set(typeIri, typeSlots.size);
  }
  return (isDark() ? PALETTE_DARK : PALETTE_LIGHT)[typeSlots.get(typeIri)];
}

/* ----------------------------------------------------------------- graph */
let cy = null;
const nodeMeta = new Map();

function buildCyStyle() {
  return [
    { selector: "node", style: {
      "background-color": (n) => typeColor(n.data("type")),
      label: (n) => n.data("label") || localName(n.data("id")),
      "font-size": 10, "text-wrap": "wrap", "text-max-width": 130,
      "text-valign": "bottom", "text-margin-y": 4, color: cssVar("--ink-1"),
      width: 22, height: 22, "border-width": 1.5, "border-color": cssVar("--ring"),
    } },
    { selector: "node[?blank]", style: { shape: "diamond", "background-color": cssVar("--muted") } },
    { selector: "node.expanded", style: { "border-width": 3, "border-color": cssVar("--baseline") } },
    { selector: "node:selected", style: { "border-width": 3, "border-color": cssVar("--accent") } },
    { selector: "edge", style: {
      width: 1.5, "curve-style": "bezier", "line-color": cssVar("--baseline"),
      "target-arrow-shape": "triangle", "target-arrow-color": cssVar("--baseline"), "arrow-scale": 0.9,
      label: (e) => localName(e.data("p")), "font-size": 8, color: cssVar("--muted"),
      "text-rotation": "autorotate", "text-background-color": cssVar("--surface"),
      "text-background-opacity": 0.85, "text-background-padding": 1,
    } },
  ];
}

let tapTimer = null;
function ensureCy() {
  if (cy) return cy;
  cy = cytoscape({ container: $("cy"), wheelSensitivity: 0.25, style: buildCyStyle() });
  // cytoscape emits tap twice before dbltap; debounce so a drill-down does not
  // also fire two detail-panel loads (4 extra queries per double-click).
  cy.on("tap", "node", (e) => {
    const id = e.target.data("id");
    clearTimeout(tapTimer);
    tapTimer = setTimeout(() => showNode(id), 250);
  });
  cy.on("dbltap", "node", (e) => {
    clearTimeout(tapTimer);
    expandNode(e.target.data("id"));
  });
  return cy;
}

function refreshChrome() {
  const n = cy ? cy.nodes().length : 0;
  const hasOffer = lastSelect && lastSelect.spo;
  $("graphBar").classList.toggle("hidden", n === 0 && !hasOffer);
  $("empty").classList.toggle("hidden", n > 0 || stageMode === "table");
  const unranked = cy ? cy.nodes().filter((x) => x.data("layer") === undefined).length : 0;
  const bits = [`${n} nodes`, `${cy ? cy.edges().length : 0} edges`];
  if (conn && conn.layerProperty && n) bits.push(`${n - unranked}/${n} ranked`);
  $("graphMeta").textContent = bits.join(" · ");
}

function addTriples(parsed, { relayout = true } = {}) {
  const c = ensureCy();
  const triples = parsed.triples || parsed;
  const seen = new Set(c.nodes().map((n) => n.id()));
  const eSeen = new Set(c.edges().map((e) => e.id()));
  const add = [], fresh = [];
  const pushNode = (id, blank) => {
    if (seen.has(id)) return;
    seen.add(id);
    if (!blank) fresh.push(id);
    add.push({ data: { id, blank: blank ? 1 : undefined } });
  };
  for (const t of triples) {
    if (t.o.type === "literal") {
      const m = nodeMeta.get(t.s) || {};
      (m.lits = m.lits || []).push({ p: t.p, o: t.o });
      if (!m.label && (t.p.endsWith("#label") || t.p.endsWith("/title") || t.p.endsWith("#prefLabel")))
        m.label = t.o.value;
      nodeMeta.set(t.s, m);
      continue;
    }
    pushNode(t.s, t.sType === "bnode");
    pushNode(t.o.value, t.o.type === "bnode");
    if (t.p === BASE_PREFIXES.rdf + "type") {
      const m = nodeMeta.get(t.s) || {};
      (m.types = m.types || []); if (!m.types.includes(t.o.value)) m.types.push(t.o.value);
      nodeMeta.set(t.s, m);
      continue;
    }
    const eid = `${t.s}|${t.p}|${t.o.value}`;
    if (!eSeen.has(eid)) { eSeen.add(eid); add.push({ data: { id: eid, source: t.s, target: t.o.value, p: t.p } }); }
  }
  c.add(add);
  syncNodeData();
  if (fresh.length) enrich(fresh).then(() => { syncNodeData(); if (relayout) layoutNow(); refreshChrome(); });
  if (relayout && add.length) layoutNow();
  if (parsed.errors && parsed.errors.length)
    $("runStatus").textContent = `${parsed.errors.length} line(s) could not be parsed`;
  stageMode = "graph";
  refreshChrome();
}

function syncNodeData() {
  if (!cy) return;
  cy.nodes().forEach((n) => {
    const m = nodeMeta.get(n.id());
    if (!m) return;
    let type;
    if (m.types && m.types.length) {
      const styled = m.types.filter((t) => Object.keys((conn && conn.classStyles) || {}).some((k) => t.includes(k)));
      type = (styled.length ? styled : [...m.types].sort())[0];
    }
    n.data({ label: m.label, type, layer: m.layer });
  });
}

/** Three narrow queries rather than one cross-product: OPTIONALs multiplied
 *  together with a global LIMIT starved most nodes of labels (6 of 40 on
 *  Wikidata). Batches stay small so a slow endpoint degrades gracefully. */
async function enrich(iris) {
  const real = iris.filter((i) => !i.startsWith("_:") && R.isSafeIri(i));
  const langs = String((conn && conn.lang) || "en").split(",").map((s) => s.trim()).filter(Boolean);
  const langFilter = langs.length
    ? `FILTER(LANG(?l) = "" || LANG(?l) IN (${langs.map((l) => `"${l}"`).join(", ")}))` : "";
  for (let i = 0; i < real.length; i += 25) {
    const values = real.slice(i, i + 25).map((x) => R.iriRef(x)).join(" ");
    const jobs = [
      [`SELECT ?x ?l WHERE { VALUES ?x { ${values} }
          OPTIONAL { ?x <${BASE_PREFIXES.rdfs}label>|<${BASE_PREFIXES.dcterms}title>|<${BASE_PREFIXES.skos}prefLabel> ?l ${langFilter} } } LIMIT 400`,
       (b, m) => {
         if (!b.l) return;
         const rank = b.l["xml:lang"] ? langs.indexOf(b.l["xml:lang"]) : langs.length;
         const score = rank === -1 ? 98 : rank;
         if (!m.label || score < (m.labelRank ?? 99)) { m.label = b.l.value; m.labelRank = score; }
       }],
      [`SELECT ?x ?t WHERE { VALUES ?x { ${values} } OPTIONAL { ?x a ?t } } LIMIT 400`,
       (b, m) => { if (b.t) { m.types = m.types || []; if (!m.types.includes(b.t.value)) m.types.push(b.t.value); } }],
    ];
    if (conn.layerProperty && R.isSafeIri(conn.layerProperty))
      jobs.push([`SELECT ?x ?layer WHERE { VALUES ?x { ${values} } OPTIONAL { ?x ${R.iriRef(conn.layerProperty)} ?layer } } LIMIT 400`,
        (b, m) => { if (b.layer && !Number.isNaN(+b.layer.value)) m.layer = +b.layer.value; }]);
    await Promise.all(jobs.map(async ([q, apply]) => {
      try {
        const res = await sparqlJSON(q);
        for (const b of res.results.bindings) {
          if (!b.x) continue;
          const m = nodeMeta.get(b.x.value) || {};
          apply(b, m);
          nodeMeta.set(b.x.value, m);
        }
      } catch { /* enrichment is best-effort; the graph still renders */ }
    }));
  }
}

function layoutNow() {
  if (!cy || !cy.nodes().length) return;
  const nodes = cy.nodes();
  const ranked = nodes.filter((n) => n.data("layer") !== undefined);
  // Layered only when the ranks actually describe most of the graph; otherwise
  // the unranked majority collapses into one meaningless row.
  if (conn.layerProperty && ranked.length >= Math.max(2, nodes.length * 0.6)) {
    const rows = new Map();
    nodes.sort((a, b) => (a.data("layer") ?? 1e9) - (b.data("layer") ?? 1e9))
      .forEach((n) => {
        const r = n.data("layer") ?? "unranked";
        if (!rows.has(r)) rows.set(r, []);
        rows.get(r).push(n);
      });
    const keys = [...rows.keys()].filter((k) => k !== "unranked").sort((a, b) => a - b);
    if (rows.has("unranked")) keys.push("unranked");
    let y = 0;
    for (const k of keys) {
      const bucket = rows.get(k);
      const perRow = k === "unranked" ? Math.ceil(Math.sqrt(bucket.length)) : bucket.length;
      for (let i = 0; i < bucket.length; i++) {
        const row = Math.floor(i / perRow), col = i % perRow;
        const width = Math.min(perRow, bucket.length - row * perRow);
        bucket[i].position({ x: (col - width / 2) * 180, y: y + row * 90 });
      }
      y += Math.ceil(bucket.length / perRow) * 90 + 90;
    }
    cy.layout({ name: "preset", fit: cy.nodes().length <= 2, padding: 40 }).run();
  } else {
    cy.layout({ name: "cose", fit: cy.nodes().length <= 2, padding: 40, animate: false,
                nodeRepulsion: 9000, idealEdgeLength: 95 }).run();
  }
}

function clearGraph() {
  if (cy) cy.elements().remove();
  nodeMeta.clear(); typeSlots.clear();
  lastSelect = null;
  stageMode = "empty";
  $("panel").classList.add("hidden");
  $("tableWrap").classList.add("hidden");
  $("btnToggleView").classList.add("hidden");
  $("tbl").replaceChildren();
  $("tableMeta").textContent = "";
  hideError();
  refreshChrome();
}

/* ----------------------------------------------------------- node detail */
async function showNode(iri) {
  const panel = $("panel");
  panel.classList.remove("hidden");
  panel.replaceChildren(el("div", "muted", "loading…"));
  const m = nodeMeta.get(iri) || {};

  const head = () => {
    panel.replaceChildren();
    const close = el("button", "close", "✕");
    close.setAttribute("aria-label", "close details");
    close.onclick = () => panel.classList.add("hidden");
    panel.append(close, el("h2", null, m.label || localName(iri)));
    const idDiv = el("div", "iri", compact(iri)); idDiv.title = iri;
    panel.append(idDiv);
    if (m.types && m.types.length) panel.append(el("div", "muted", m.types.map(compact).join(" · ")));
  };

  if (iri.startsWith("_:")) {
    head();
    panel.append(el("div", "note",
      "Blank node. SPARQL cannot address another document's blank node, so it cannot be queried or expanded — only the triples already loaded are shown."));
    if (m.lits && m.lits.length) {
      const kv = el("div", "kv");
      for (const l of m.lits) { kv.append(el("div", "k", compact(l.p)), el("div", "v", l.o.value)); }
      panel.append(el("h4", null, "Properties"), kv);
    }
    return;
  }

  let lits = [], rels = [];
  try {
    const ref = R.iriRef(iri);
    lits = (await sparqlJSON(`SELECT ?p ?o WHERE { ${ref} ?p ?o . FILTER(isLiteral(?o)) } LIMIT 200`)).results.bindings;
    rels = (await sparqlJSON(
      `SELECT ?p ?dir (COUNT(*) AS ?n) WHERE {
         { ${ref} ?p ?x . FILTER(!isLiteral(?x)) BIND("out" AS ?dir) }
         UNION { ?x ?p ${ref} . BIND("in" AS ?dir) } } GROUP BY ?p ?dir ORDER BY DESC(?n) LIMIT 60`)).results.bindings;
  } catch (e) {
    head();
    panel.append(el("div", "error", e.message));
    return;
  }

  head();
  const propSec = el("section");
  propSec.append(el("h4", null, `Properties (${lits.length})`));
  const kv = el("div", "kv");
  for (const b of lits) {
    kv.append(el("div", "k", compact(b.p.value)));
    kv.append(el("div", "v", b.o.value + (b.o["xml:lang"] ? `  @${b.o["xml:lang"]}` : "")));
  }
  if (!lits.length) kv.append(el("div", "muted", "—"), el("div", null, ""));
  propSec.append(kv);
  panel.append(propSec);

  const relSec = el("section");
  relSec.append(el("h4", null, "Relationships — click to expand"));
  for (const b of rels) {
    const btn = el("button", "expandBtn",
      `${b.dir.value === "out" ? "→" : "←"} ${compact(b.p.value)} (${b.n.value})`);
    btn.onclick = () => expandNode(iri, { predicate: b.p.value, dir: b.dir.value });
    relSec.append(btn);
  }
  if (!rels.length) relSec.append(el("div", "muted", "—"));
  panel.append(relSec);
}

async function expandNode(iri, { predicate, dir } = {}) {
  if (iri.startsWith("_:")) {
    showError("Blank nodes cannot be expanded — SPARQL has no way to address them.");
    return;
  }
  const status = $("runStatus");
  status.textContent = "expanding…";
  try {
    const ref = R.iriRef(iri);
    let q;
    if (predicate) {
      const p = R.iriRef(predicate);
      q = dir === "in"
        ? `CONSTRUCT { ?s ${p} ${ref} } WHERE { ?s ${p} ${ref} } LIMIT 50`
        : `CONSTRUCT { ${ref} ${p} ?o } WHERE { ${ref} ${p} ?o . FILTER(!isLiteral(?o)) } LIMIT 50`;
    } else {
      q = `CONSTRUCT { ${ref} ?p ?o . ?s ?p2 ${ref} } WHERE {
             { SELECT ?p ?o WHERE { ${ref} ?p ?o . FILTER(!isLiteral(?o)) } LIMIT 25 }
             UNION { SELECT ?s ?p2 WHERE { ?s ?p2 ${ref} } LIMIT 25 } }`;
    }
    const parsed = await sparqlTriples(q);
    showStage("graph");
    addTriples(parsed);
    if (cy) cy.getElementById(iri).addClass("expanded");
    status.textContent = parsed.triples.length ? `+${parsed.triples.length} triples` : "nothing further to expand";
  } catch (e) {
    status.textContent = "";
    showError(`expand failed — ${e.message}`);
  }
}

/* ----------------------------------------------------------------- table */
function renderTable(res) {
  const vars = res.head.vars;
  const rows = res.results.bindings;
  $("tableMeta").textContent = `${rows.length} row${rows.length === 1 ? "" : "s"}`;
  const tbl = $("tbl");
  tbl.replaceChildren();
  const thead = el("thead"), trh = el("tr");
  vars.forEach((v) => trh.append(el("th", null, "?" + v)));
  thead.append(trh); tbl.append(thead);
  const tbody = el("tbody");
  for (const b of rows) {
    const tr = el("tr");
    for (const v of vars) {
      const cell = b[v];
      const td = el("td");
      td.setAttribute("dir", "auto");
      if (!cell) { td.textContent = ""; }
      else if (cell.type === "uri") {
        const btn = el("button", "iri", compact(cell.value));
        btn.title = `${cell.value}\n(click to add to the graph)`;
        btn.onclick = () => { showStage("graph"); addSingle(cell.value); };
        td.append(btn);
      } else td.textContent = cell.value + (cell["xml:lang"] ? `  @${cell["xml:lang"]}` : "");
      tr.append(td);
    }
    tbody.append(tr);
  }
  tbl.append(tbody);

  // Offer a graph view only when the middle column really is a predicate
  // column — three columns with any two IRIs also matches (?w ?title ?status),
  // which would fabricate edges labelled with document titles.
  const spo = vars.length === 3 &&
    rows.length > 0 &&
    rows.every((r) => !r[vars[1]] || r[vars[1]].type === "uri") &&
    rows.every((r) => !r[vars[0]] || r[vars[0]].type === "uri");
  lastSelect = { res, spo, vars };
  const btn = $("btnToggleView");
  btn.classList.toggle("hidden", !spo);
  btn.textContent = "view as graph";
  refreshChrome();
}

function addSingle(iri) {
  ensureCy();
  if (!cy.getElementById(iri).length) cy.add({ data: { id: iri, blank: iri.startsWith("_:") ? 1 : undefined } });
  enrich([iri]).then(() => { syncNodeData(); layoutNow(); refreshChrome(); });
  stageMode = "graph";
  refreshChrome();
}

function selectRowsToTriples() {
  const { res, vars } = lastSelect;
  const [sv, pv, ov] = vars;
  return {
    triples: res.results.bindings
      .filter((r) => r[sv] && r[ov])
      .map((r) => ({
        s: r[sv].value, sType: r[sv].type === "bnode" ? "bnode" : "uri",
        p: r[pv] ? r[pv].value : "urn:scope:related",
        o: r[ov].type === "literal"
          ? { type: "literal", value: r[ov].value, lang: r[ov]["xml:lang"] }
          : { type: r[ov].type === "bnode" ? "bnode" : "uri", value: r[ov].value },
      })),
    errors: [],
  };
}

/* ------------------------------------------------------------ stage/error */
function showStage(which) {
  stageMode = which;
  $("tableWrap").classList.toggle("hidden", which !== "table");
  $("cy").classList.toggle("hidden", which === "table");
  const btn = $("btnToggleView");
  if (lastSelect && lastSelect.spo) btn.textContent = which === "table" ? "view as graph" : "view as table";
  refreshChrome();
}
function showError(msg) {
  const bar = $("errBar");
  bar.replaceChildren(el("span", null, msg));
  const x = el("button", "close", "✕");
  x.setAttribute("aria-label", "dismiss");
  x.onclick = hideError;
  bar.append(x);
  bar.classList.remove("hidden");
}
function hideError() { $("errBar").classList.add("hidden"); }

/* --------------------------------------------------------------------- run */
async function run() {
  hideError();
  let q = editor.getValue();
  const form = R.queryForm(q);
  const status = $("runStatus");
  if (!R.READ_FORMS.has(form)) {
    showError(form === "UNKNOWN"
      ? "Could not recognise this as a SPARQL query. The viewer only runs SELECT, CONSTRUCT, ASK and DESCRIBE."
      : `SPARQL Registry Viewer is read-only — it will not send a ${form} request.`);
    return;
  }
  if (R.usesFederation(q)) {
    showError("This query uses SPARQL federation (SERVICE). The viewer refuses it by default: SERVICE makes the "
      + "endpoint fetch a URL chosen by the query, which the proxy's allowlist cannot police. "
      + "An operator can enable it with SCOPE_ALLOW_SERVICE=1.");
    return;
  }
  if ($("limitGuard").checked) q = R.withLimit(q, 200);
  status.textContent = "running…";
  const t0 = performance.now();
  try {
    if (form === "SELECT") {
      const res = await sparqlJSON(q);
      showStage("table");
      renderTable(res);
    } else if (form === "ASK") {
      const res = await sparqlJSON(q);
      status.textContent = `ASK → ${res.boolean}`;
      showError(`ASK result: ${res.boolean}`);
      return;
    } else {
      const parsed = await sparqlTriples(q);
      if (!parsed.triples.length) {
        status.textContent = "0 triples";
        showError(parsed.errors.length
          ? `No triples parsed; ${parsed.errors.length} line(s) were malformed (first: ${parsed.errors[0].message}).`
          : "The query returned no triples.");
        return;
      }
      showStage("graph");
      addTriples(parsed);
    }
    status.textContent = `${form} · ${((performance.now() - t0) / 1000).toFixed(1)}s`;
    const key = `scopeHist:${conn.name}`;
    try {
      const prev = JSON.parse(localStorage.getItem(key) || "[]");
      const hist = [q, ...(Array.isArray(prev) ? prev : []).filter((x) => x !== q)].slice(0, 20);
      localStorage.setItem(key, JSON.stringify(hist));
    } catch { /* storage full or blocked — history is a convenience */ }
  } catch (e) {
    status.textContent = "";
    showError(e.message);
  }
}

async function listGraphs() {
  hideError();
  $("runStatus").textContent = "listing named graphs…";
  try {
    // Deliberately without defaultGraphs: pinning a default graph empties the
    // named-graph set, so GRAPH ?g could never match and it would report zero.
    const res = await sparqlJSON(
      "SELECT ?g (COUNT(*) AS ?triples) WHERE { GRAPH ?g { ?s ?p ?o } } GROUP BY ?g ORDER BY DESC(?triples) LIMIT 100",
      { withDefaultGraphs: false });
    showStage("table");
    renderTable(res);
    if (!res.results.bindings.length)
      showError("This endpoint reports no named graphs (some stores, including Wikidata, do not expose GRAPH).");
    else if (conn.defaultGraphs && conn.defaultGraphs.length)
      $("tableMeta").textContent += ` — note: this connection pins ${conn.defaultGraphs.length} default graph(s); queries you run are scoped to those`;
  } catch (e) { showError(`named-graph listing failed — ${e.message}`); }
  $("runStatus").textContent = "";
}

/* -------------------------------------------------------- connections UI */
function openConnDlg() {
  const dlg = $("connDlg");
  const list = $("connList");
  let custom = [];
  try { const p = JSON.parse(localStorage.getItem("scopeConns") || "[]"); if (Array.isArray(p)) custom = p; } catch { /* ignore */ }
  list.replaceChildren(...connections.map((c, i) => {
    const row = el("div", "conn");
    row.append(el("span", "name", c.name || c.endpoint), el("span", "badge", c.mode || "direct"));
    const use = el("button", null, "use");
    use.type = "button";
    use.onclick = () => { $("connSelect").value = String(i); localStorage.setItem("scopeConnIdx", String(i)); setConn(c); dlg.close(); };
    const edit = el("button", null, "edit");
    edit.type = "button";
    edit.onclick = () => { $("cName").value = c.name || ""; $("cUrl").value = c.endpoint; $("cMode").value = c.mode || "direct"; $("cLang").value = c.lang || ""; };
    row.append(use, edit);
    if (custom.some((x) => x.name === c.name)) {
      const del = el("button", null, "remove");
      del.type = "button";
      del.onclick = () => {
        localStorage.setItem("scopeConns", JSON.stringify(custom.filter((x) => x.name !== c.name)));
        loadConfig().then(openConnDlg);
      };
      row.append(del);
    }
    return row;
  }));
  $("cErr").textContent = "";
  dlg.showModal();
}

function saveConn() {
  const c = { name: $("cName").value.trim(), endpoint: $("cUrl").value.trim(),
              mode: $("cMode").value, lang: $("cLang").value.trim() || "en" };
  if (!c.name || !c.endpoint) { $("cErr").textContent = "Name and endpoint URL are both required."; return; }
  if (!/^https?:\/\//i.test(c.endpoint)) { $("cErr").textContent = "Endpoint must start with http:// or https://"; return; }
  let custom = [];
  try { const p = JSON.parse(localStorage.getItem("scopeConns") || "[]"); if (Array.isArray(p)) custom = p; } catch { /* ignore */ }
  localStorage.setItem("scopeConns", JSON.stringify([...custom.filter((x) => x.name !== c.name), c]));
  $("cName").value = ""; $("cUrl").value = ""; $("cErr").textContent = "";
  loadConfig().then(openConnDlg);
}

/* -------------------------------------------------------------------- boot */
function initEditor() {
  const startQ = "SELECT ?s ?p ?o WHERE { ?s ?p ?o } LIMIT 25";
  try {
    // Every upstream default that could reach the network is disabled:
    // YASQE ships its own Ctrl/Cmd-Enter that POSTs to dbpedia.org, and its
    // prefix autocompleter fetches prefix.cc on load. The viewer owns query
    // execution, and must work on an offline LAN.
    const y = new Yasqe($("yasqe"), {
      showQueryButton: false, resizeable: true, persistenceId: null,
      autocompleters: [],
      queryingDisabled: "SPARQL Registry Viewer runs the query itself",
      requestConfig: { endpoint: "" },
      extraKeys: { "Ctrl-Enter": null, "Cmd-Enter": null, "Ctrl-S": null },
    });
    y.setValue(startQ);
    editor = { getValue: () => y.getValue(), setValue: (v) => y.setValue(v) };
  } catch {
    const ta = el("textarea");
    ta.id = "fallbackEditor";
    ta.value = startQ;
    $("yasqe").replaceChildren(ta);
    editor = { getValue: () => ta.value, setValue: (v) => { ta.value = v; } };
  }
}

function applyTheme(next) {
  document.documentElement.dataset.theme = next;
  try { localStorage.setItem("scopeTheme", next); } catch { /* ignore */ }
  if (cy) { typeSlots.clear(); cy.style().fromJson(buildCyStyle()).update(); }
}

$("btnRun").onclick = run;
$("btnGraphs").onclick = listGraphs;
$("btnRelayout").onclick = layoutNow;
$("btnClear").onclick = clearGraph;
$("btnFit").onclick = () => cy && cy.fit(undefined, 40);
$("connEdit").onclick = openConnDlg;
$("cSave").onclick = saveConn;
$("cClose").onclick = () => $("connDlg").close();
$("btnToggleView").onclick = () => {
  if (!lastSelect || !lastSelect.spo) return;
  if (stageMode === "table") { showStage("graph"); addTriples(selectRowsToTriples()); }
  else { showStage("table"); renderTable(lastSelect.res); }
};
$("connSelect").onchange = (e) => {
  localStorage.setItem("scopeConnIdx", e.target.value);
  setConn(connections[+e.target.value]);
};
$("history").onchange = (e) => { if (e.target.value) editor.setValue(e.target.value); e.target.selectedIndex = 0; };
$("samples").onchange = (e) => { if (e.target.value) editor.setValue(e.target.value); e.target.selectedIndex = 0; };
$("btnTheme").onclick = () => applyTheme(isDark() ? "light" : "dark");
document.addEventListener("keydown", (e) => {
  if ((e.ctrlKey || e.metaKey) && e.key === "Enter") { e.preventDefault(); run(); }
});

/* ---------------------------------------------------------- panel resize */
{
  const grip = $("panelGrip");
  const PANEL_MIN = 260; // keep in step with #panel min/max-width in style.css
  const setPanelWidth = (w) => {
    const max = Math.max(PANEL_MIN, Math.round(innerWidth * 0.7));
    const px = Math.min(Math.max(Math.round(w), PANEL_MIN), max);
    document.documentElement.style.setProperty("--panel-w", px + "px");
    grip.setAttribute("aria-valuemax", String(max));
    grip.setAttribute("aria-valuenow", String(px));
    return px;
  };
  const savePanelWidth = (px) => {
    try { localStorage.setItem("scopePanelW", String(px)); } catch { /* ignore */ }
  };
  // The panel sits at the inline end, so dragging the divider left widens it.
  grip.onpointerdown = (e) => {
    if (e.button > 0) return;
    e.preventDefault();
    grip.setPointerCapture(e.pointerId);
    const startX = e.clientX;
    let px = $("panel").getBoundingClientRect().width;
    const startW = px;
    grip.onpointermove = (ev) => { px = setPanelWidth(startW + (startX - ev.clientX)); };
    grip.onpointerup = grip.onpointercancel = () => {
      grip.onpointermove = grip.onpointerup = grip.onpointercancel = null;
      savePanelWidth(px);
    };
  };
  grip.onkeydown = (e) => {
    if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
    e.preventDefault();
    const cur = $("panel").getBoundingClientRect().width;
    savePanelWidth(setPanelWidth(cur + (e.key === "ArrowLeft" ? 24 : -24)));
  };
  grip.ondblclick = () => {
    document.documentElement.style.removeProperty("--panel-w");
    grip.setAttribute("aria-valuenow", "360");
    try { localStorage.removeItem("scopePanelW"); } catch { /* ignore */ }
  };
  try {
    const saved = parseInt(localStorage.getItem("scopePanelW") || "", 10);
    if (Number.isInteger(saved)) setPanelWidth(saved);
  } catch { /* ignore */ }
}

initEditor();
loadConfig();
