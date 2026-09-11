# Third-Party Benchmark Notices

## Harbor

The production evaluation integration depends on Harbor 0.22.0 without modifying
its source. The migration audited public extension behavior at commit
`106d19109903b45a1c9467e340765496176628ae`.

- Upstream: https://github.com/laude-institute/harbor
- License: Apache License 2.0

Historical `HB-*` smoke fixtures were adapted earlier from
`harbor-framework/harbor` commit
`b7e2f71b4563618af3a42279740f5f412dcf7046`; their `UPSTREAM.md` files retain
that provenance.

Those historical adaptations are not official Harbor scores. Current production
evaluation runs through Harbor itself.

## QuixBugs

The `QB-*` smoke tasks contain programs and test vectors from `jkoppel/QuixBugs` commit `4257f44b0ff1181dedaedee6a447e133219fcebf`.

- Copyright 2017-2019 James Koppel
- Upstream: https://github.com/jkoppel/QuixBugs
- License: MIT
- Harbor adapter reference: `harbor-framework/harbor/adapters/quixbugs`

Permission is hereby granted, free of charge, to any person obtaining a copy of this software and associated documentation files (the "Software"), to deal in the Software without restriction, including without limitation the rights to use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies of the Software, and to permit persons to whom the Software is furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.
