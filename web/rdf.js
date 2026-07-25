/* SPARQL Registry Viewer — RDF/SPARQL core.
 *
 * Pure, dependency-free, and unit-tested (test/rdf.test.mjs). Kept separate
 * from app.js precisely because these are the parts where "silently wrong" is
 * worse than "visibly broken": query-form classification (the read-only gate)
 * and N-Triples parsing (everything the graph renders).
 *
 * Loaded as a plain script in the browser (window.ScopeRDF) and imported by
 * the test suite in node.
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  root.ScopeRDF = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";

  /* ------------------------------------------------------------ comments */
  /** Strip SPARQL comments, honouring string literals and IRIs — a '#' inside
   *  <http://…/ns#> or "a # b" is data, not a comment. */
  function stripComments(q) {
    let out = "";
    for (let i = 0; i < q.length; i++) {
      const c = q[i];
      if (c === "<") { // IRI: no escapes, runs to '>' (or newline = not an IRI)
        const end = q.indexOf(">", i);
        const nl = q.indexOf("\n", i);
        if (end !== -1 && (nl === -1 || end < nl)) { out += q.slice(i, end + 1); i = end; continue; }
        out += c; continue;
      }
      if (c === '"' || c === "'") {
        const triple = q.slice(i, i + 3) === c + c + c;
        const quote = triple ? c + c + c : c;
        let j = i + quote.length;
        while (j < q.length) {
          if (q[j] === "\\") { j += 2; continue; }
          if (q.slice(j, j + quote.length) === quote) break;
          j++;
        }
        const stop = Math.min(j + quote.length, q.length);
        out += q.slice(i, stop);
        i = stop - 1;
        continue;
      }
      if (c === "#") { const nl = q.indexOf("\n", i); if (nl === -1) break; out += "\n"; i = nl; continue; }
      out += c;
    }
    return out;
  }

  const READ_FORMS = new Set(["SELECT", "CONSTRUCT", "ASK", "DESCRIBE"]);
  const UPDATE_FORMS = new Set(["INSERT", "DELETE", "LOAD", "CLEAR", "DROP",
                                "CREATE", "WITH", "COPY", "MOVE", "ADD"]);

  /** Classify a SPARQL request by consuming the prologue exactly as the
   *  grammar defines it — Prologue ::= (BaseDecl | PrefixDecl)* — and reading
   *  the keyword that follows. A prefix *named* after a form (PREFIX select:)
   *  therefore cannot masquerade as that form. Unknown input fails closed. */
  function queryForm(query) {
    let s = stripComments(String(query == null ? "" : query))
      .replace(/^﻿/, "");
    for (;;) {
      const before = s;
      s = s.replace(/^\s+/, "");
      const pfx = s.match(/^PREFIX\s+[^\s:<>"{}|^`\\]*:\s*<[^<>"{}|^`\\]*>/i);
      if (pfx) { s = s.slice(pfx[0].length); continue; }
      const base = s.match(/^BASE\s*<[^<>"{}|^`\\]*>/i);
      if (base) { s = s.slice(base[0].length); continue; }
      if (s === before) break;
    }
    const m = s.match(/^([A-Za-z]+)/);
    if (!m) return "UNKNOWN";
    const kw = m[1].toUpperCase();
    if (READ_FORMS.has(kw) || UPDATE_FORMS.has(kw)) return kw;
    return "UNKNOWN";
  }

  const isReadOnlyForm = (q) => READ_FORMS.has(queryForm(q));

  /** Does the query use SPARQL federation (SERVICE)?
   *
   *  A read-only query is still a request the *endpoint* executes: SERVICE
   *  makes the trusted store fetch an attacker-chosen URL, so an allowlist on
   *  the endpoint itself does not contain it. Detected on both sides and
   *  refused by default. Variables (?service) and prefixed names (ex:service)
   *  are not the keyword. */
  function usesFederation(query) {
    const s = stripComments(String(query == null ? "" : query))
      .replace(/<[^<>"{}|^`\\]*>/g, " ")
      .replace(/"""[\s\S]*?"""|'''[\s\S]*?'''|"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'/g, " ");
    return /(^|[^?$:\w])SERVICE\b/i.test(s);
  }

  /* -------------------------------------------------------------- escapes */
  function unescapeRdf(str) {
    let out = "";
    for (let i = 0; i < str.length; i++) {
      if (str[i] !== "\\") { out += str[i]; continue; }
      const c = str[++i];
      switch (c) {
        case "t": out += "\t"; break;
        case "b": out += "\b"; break;
        case "n": out += "\n"; break;
        case "r": out += "\r"; break;
        case "f": out += "\f"; break;
        case '"': out += '"'; break;
        case "'": out += "'"; break;
        case "\\": out += "\\"; break;
        case "u": { const h = str.substr(i + 1, 4); out += cp(h, 4); i += 4; break; }
        case "U": { const h = str.substr(i + 1, 8); out += cp(h, 8); i += 8; break; }
        default: out += "\\" + (c === undefined ? "" : c);
      }
    }
    return out;
    function cp(hex, len) {
      if (hex.length !== len || !/^[0-9A-Fa-f]+$/.test(hex)) return "\\" + (len === 4 ? "u" : "U") + hex;
      const n = parseInt(hex, 16);
      return n > 0x10ffff ? "�" : String.fromCodePoint(n);
    }
  }

  /** Characters SPARQL's IRIREF production forbids outright (no escape exists
   *  for them inside <…>), so an IRI containing one cannot be interpolated. */
  const IRI_FORBIDDEN = /[<>"{}|^`\\]|[\u0000-\u0020]/;
  const isSafeIri = (iri) => typeof iri === "string" && iri.length > 0 && !IRI_FORBIDDEN.test(iri);
  function iriRef(iri) {
    if (!isSafeIri(iri))
      throw new Error(`IRI cannot be used in a SPARQL query (contains characters SPARQL forbids): ${String(iri).slice(0, 120)}`);
    return `<${iri}>`;
  }
  const escapeLiteral = (s) => String(s)
    .replace(/\\/g, "\\\\").replace(/"/g, '\\"')
    .replace(/\n/g, "\\n").replace(/\r/g, "\\r").replace(/\t/g, "\\t");

  /* ------------------------------------------------------- N-Triples parse */
  /** Parse N-Triples (the serialization we request for CONSTRUCT/DESCRIBE).
   *  Returns {triples, errors, lines}. Blank nodes are preserved — dropping
   *  them silently loses real data on DESCRIBE-heavy endpoints. */
  function parseNTriples(text) {
    const triples = [];
    const errors = [];
    let lines = 0;
    for (const raw of String(text == null ? "" : text).split(/\r\n|\n|\r/)) {
      const line = raw.trim();
      if (!line || line.startsWith("#")) continue;
      lines++;
      try {
        const t = parseLine(line);
        if (t) triples.push(t);
      } catch (e) {
        if (errors.length < 20) errors.push({ line: line.slice(0, 200), message: e.message });
      }
    }
    return { triples, errors, lines };
  }

  function parseLine(line) {
    let i = 0;
    const ws = () => { while (i < line.length && /[\s]/.test(line[i])) i++; };

    function term(allowLiteral) {
      ws();
      if (line[i] === "<") {
        const end = line.indexOf(">", i);
        if (end === -1) throw new Error("unterminated IRI");
        const iri = unescapeRdf(line.slice(i + 1, end));
        i = end + 1;
        return { type: "uri", value: iri };
      }
      if (line[i] === "_" && line[i + 1] === ":") {
        const m = line.slice(i).match(/^_:[^\s.]+/);
        if (!m) throw new Error("bad blank node");
        i += m[0].length;
        return { type: "bnode", value: m[0] };
      }
      if (allowLiteral && line[i] === '"') {
        let j = i + 1, buf = "";
        for (;;) {
          if (j >= line.length) throw new Error("unterminated literal");
          if (line[j] === "\\") { buf += line[j] + (line[j + 1] || ""); j += 2; continue; }
          if (line[j] === '"') break;
          buf += line[j++];
        }
        j++; // closing quote
        const out = { type: "literal", value: unescapeRdf(buf) };
        if (line[j] === "@") {
          const m = line.slice(j).match(/^@[A-Za-z]+(?:-[A-Za-z0-9]+)*/);
          if (!m) throw new Error("bad language tag");
          out.lang = m[0].slice(1);
          j += m[0].length;
        } else if (line[j] === "^" && line[j + 1] === "^") {
          j += 2;
          if (line[j] !== "<") throw new Error("bad datatype");
          const end = line.indexOf(">", j);
          if (end === -1) throw new Error("unterminated datatype IRI");
          out.datatype = unescapeRdf(line.slice(j + 1, end));
          j = end + 1;
        }
        i = j;
        return out;
      }
      throw new Error(`unexpected token at ${i}`);
    }

    const s = term(false);
    const p = term(false);
    if (p.type !== "uri") throw new Error("predicate must be an IRI");
    const o = term(true);
    ws();
    if (line[i] !== ".") throw new Error("missing terminating '.'");
    return { s: s.value, sType: s.type, p: p.value, o };
  }

  /* ------------------------------------------------------------ shortening */
  function compactWith(prefixes, iri) {
    let best = null;
    for (const [p, ns] of Object.entries(prefixes || {}))
      if (typeof ns === "string" && iri.startsWith(ns) && (!best || ns.length > best[1].length))
        best = [p, ns];
    return best ? `${best[0]}:${iri.slice(best[1].length)}` : iri;
  }

  /** Human-readable short name. Never throws: decodeURIComponent rejects a
   *  bare '%' , and this runs inside render callbacks where a throw would
   *  blank the canvas. */
  function localNameWith(prefixes, iri) {
    const c = compactWith(prefixes, iri);
    if (c !== iri) return c;
    const m = String(iri).match(/[#/]([^#/]+)\/?$/);
    if (!m) return String(iri);
    try { return decodeURIComponent(m[1]); } catch { return m[1]; }
  }

  /* ---------------------------------------------------------- auto-LIMIT */
  /** Append a LIMIT only when it is provably safe: the query must have no
   *  top-level LIMIT and must not end inside a comment. Solution modifiers
   *  must follow the WHERE clause, so appending to a query whose last
   *  meaningful token closes a group is valid; anything else is left alone
   *  rather than risking a syntax error. */
  function withLimit(query, n) {
    const stripped = stripComments(query).trim();
    if (!stripped) return query;
    if (/\bLIMIT\s+\d+\s*$/i.test(stripped)) return query;
    const form = queryForm(query);
    if (form !== "SELECT" && form !== "CONSTRUCT" && form !== "DESCRIBE") return query;
    if (!/[}\)\s>"']$/.test(stripped) && !/^\s*DESCRIBE/i.test(stripped)) return query;
    const sep = stripComments(query) === query ? (query.endsWith("\n") ? "" : "\n") : "\n";
    return (stripComments(query) === query ? query : stripped) + sep + `LIMIT ${n}`;
  }

  return {
    stripComments, queryForm, isReadOnlyForm, usesFederation, READ_FORMS, UPDATE_FORMS,
    unescapeRdf, isSafeIri, iriRef, escapeLiteral,
    parseNTriples, compactWith, localNameWith, withLimit,
  };
});
