# Security policy

## Reporting a vulnerability

Please report security issues privately via GitHub's "Report a vulnerability"
(Security → Advisories) rather than a public issue. Include a reproduction and
the version/commit. Expect an acknowledgement within a few days.

## Threat model — read this before deploying

SPARQL Registry Viewer is a **read-only** explorer, but it ships an HTTP **proxy**, and
that is the part with real security surface.

### The proxy is an open forward proxy unless you constrain it

With `SCOPE_ALLOW` unset, `POST /proxy` will forward a SPARQL query to **any
http(s) host the container can reach** — including services on your internal
network that the user's browser could not reach directly. Anyone who can reach
the viewer inherits its network position.

- **Trusted LAN / localhost:** the default (unrestricted) is convenient.
- **Anything else:** set `SCOPE_ALLOW` to the exact hosts you intend, e.g.
  `SCOPE_ALLOW=fuseki:3030,query.wikidata.org`. Matching is on the URL's host
  (optionally `host:port`), never a substring of the URL.
- Put the viewer behind your own authentication if untrusted users can reach
  it. It has no user accounts and is not designed to be exposed to the internet.

### Protections that are implemented

- **Read-only enforcement**: SPARQL UPDATE forms (`INSERT`, `DELETE`, `LOAD`,
  `CLEAR`, `DROP`, `CREATE`, `WITH`, `COPY`, `MOVE`, `ADD`) are refused by both
  the browser and the proxy. Classification consumes the SPARQL prologue per
  the grammar, so a prefix named after a query form
  (`PREFIX select: <…> INSERT DATA …`) cannot masquerade as a read query.
  Unrecognised input fails closed. Both gates are driven by the same fixtures
  (`test/queryform-fixtures.json`) so they cannot drift apart.
- **SPARQL federation refused by default**: `SERVICE` makes the *endpoint*
  fetch a URL chosen by the query author, so an allowlist on the endpoint the
  viewer talks to cannot contain it — a read-only query is still an SSRF primitive
  executed by your trusted store. Opt in with `SCOPE_ALLOW_SERVICE=1`.
- **No redirect following**: a redirected POST would silently lose the query
  and could reach a host `SCOPE_ALLOW` never approved.
- **Credentials bind to a host**: `SCOPE_AUTH_<NAME>` is matched against the
  endpoint's host, so a hostile endpoint such as `https://evil.example/?x=fuseki`
  cannot harvest credentials intended for `fuseki`. Credentials are attached
  server-side and never sent to the browser.
- **Response handling**: proxied responses are size-capped
  (`SCOPE_MAX_BYTES`), time-limited (`SCOPE_TIMEOUT`), served with
  `X-Content-Type-Options: nosniff`, and any content type outside a small
  allowlist is relabelled `text/plain` so a hostile endpoint cannot get HTML
  executed on the viewer's origin.
- **Static file serving** decodes percent-encoding before containment checks,
  so `..%2f` traversal is rejected.
- **Untrusted RDF is treated as data**: values from an endpoint are inserted
  via `textContent`, never `innerHTML`, and IRIs are validated before being
  interpolated into a query, so a hostile IRI cannot alter query structure.

### Known limitations

- The viewer has no authentication, no authorization, and no audit log.
- In `direct` mode the browser talks to the endpoint itself; the proxy's
  protections (allowlist, size cap, redirect refusal) do not apply, and the
  read-only guard is the client-side one.
- Connections added in the UI are stored unencrypted in `localStorage`. Do not
  put credentials in an endpoint URL; use `SCOPE_AUTH_<NAME>` instead.
