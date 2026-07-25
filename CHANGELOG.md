# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/); this project uses
[Semantic Versioning](https://semver.org/).

## [0.1.0] — unreleased

First release.

### Added
- Read-only graph explorer for any SPARQL 1.1 endpoint: `CONSTRUCT`/`DESCRIBE`
  render as a graph, `SELECT` as a table with a graph view when the rows are
  triple-shaped, `ASK` answers directly.
- Node detail panel (labels, types, literal properties, in/out relationship
  counts per predicate) with per-predicate expansion; double-click for a
  bounded neighbourhood expand.
- Optional server-side proxy for endpoints without CORS, on internal
  hostnames, or needing credentials (`SCOPE_AUTH_<NAME>`, never exposed to the
  browser).
- Connection profiles: label language preference, prefixes, per-type node
  colours, layered layout by a numeric property, pinned default graphs, sample
  queries. Configurable by file or in the UI.
- Light/dark theming that follows the OS and can be overridden; RTL-correct
  rendering for Arabic and other RTL scripts.
- Self-contained container: vendored pinned libraries, no runtime CDN calls,
  works on offline LANs. Runs unprivileged.

### Security
- SPARQL UPDATE refused in the browser *and* the proxy, classified by consuming
  the SPARQL prologue per the grammar so a prefix named after a query form
  (`PREFIX select: <…> INSERT DATA …`) cannot masquerade as a read query. Both
  gates are driven by one shared fixture file.
- SPARQL federation (`SERVICE`) refused by default — it makes the endpoint
  fetch a URL chosen by the query, which an endpoint allowlist cannot police.
  Opt in with `SCOPE_ALLOW_SERVICE=1`.
- IRIs from endpoint data are validated against SPARQL's `IRIREF` production
  before entering a query, so hostile data cannot alter query structure.
- Proxy: host-based allowlist (`SCOPE_ALLOW`), host-bound credentials, no
  redirect following, response size and time caps, content-type allowlist,
  percent-decoding before static-path containment checks.
