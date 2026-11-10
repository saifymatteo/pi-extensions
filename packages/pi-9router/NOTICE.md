# Notice

**License:** AGPL-3.0-only — see [LICENSE](./LICENSE); copyright © 2026 saifymatteo.

Derived from [@xynogen/pix-9router](https://www.npmjs.com/package/@xynogen/pix-9router) and its fork [@haoyiyin/9router](https://www.npmjs.com/package/@haoyiyin/9router), both **MIT licensed**. The vendored `src/fetch.ts`, `src/search.ts`, `src/transcribe.ts`, `src/http.ts`, and `src/render.ts` are taken from those projects byte-identical except for one type-narrowing tweak in `transcribe.ts` (`validation.ok === false` where upstream used truthiness, required by this repo's non-strict TypeScript config) — and remain MIT with their original copyright notices:

```
MIT License

Copyright (c) 2026 xynogen
Copyright (c) 2026 haoyiyin

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

The provider, config, and data layers in `src/provider.ts`, `src/config.ts`, `src/data.ts`, and `src/index.ts` are new code in this repository, licensed AGPL-3.0-only as part of the package.
