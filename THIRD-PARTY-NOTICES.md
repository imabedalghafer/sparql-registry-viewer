# Third-party notices

SPARQL Scope is Apache-2.0. It **redistributes** the following components as
pre-built bundles under `web/vendor/`, each under the MIT License, which
requires that the copyright and permission notice below travel with them.

| Component | Version | License | Upstream |
|---|---|---|---|
| Cytoscape.js | 3.30.2 | MIT | https://github.com/cytoscape/cytoscape.js |
| YASQE (`@triply/yasqe`) | 4.2.28 | MIT | https://github.com/TriplyDB/yasgui |
| CodeMirror 5 | ≥5.51 (bundled inside YASQE) | MIT | https://github.com/codemirror/CodeMirror |

Copyright holders, as stated by each project:

- Cytoscape.js — Copyright (c) 2016–2024, The Cytoscape Consortium
- YASQE / YASGUI — Copyright (c) Triply B.V.
- CodeMirror 5 — Copyright (c) by Marijn Haverbeke and others

## The MIT License

> Permission is hereby granted, free of charge, to any person obtaining a copy
> of this software and associated documentation files (the "Software"), to deal
> in the Software without restriction, including without limitation the rights
> to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
> copies of the Software, and to permit persons to whom the Software is
> furnished to do so, subject to the following conditions:
>
> The above copyright notice and this permission notice shall be included in all
> copies or substantial portions of the Software.
>
> THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
> IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
> FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
> AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
> LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
> OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
> SOFTWARE.

## Why the libraries are vendored

They are committed to this repository rather than installed at runtime so that
the container has **no CDN dependency**: Scope is meant to run on isolated and
offline LANs, where a runtime fetch would hang rather than fail fast. Updating
a library means replacing the file under `web/vendor/` and updating the version
in this file.
