## S2b: cache and preload the in-browser Flutter toolkit (CHE-7630)

Spike on X99, 2026-11-19, 19:11 to 23:25 ICT. Stacked on S1b (`b7b39b31`). Evidence only: nothing here ships.

Browser: Google Chrome for Testing 158.0.8127.18, headless, Playwright, one persistent profile per scenario. Runtime: Node 22.23.5, Bun 1.3.13. Toolkit: `package:dartpad` 0.1.4, Dart 3.14.0, Flutter 3.50.0 (same pin as S1b, digests in section 7). Tailnet only (`congvc-x99.taila6fa8a.ts.net`, ports 19470 and 19471). No public URL, no C00 change, no CDN, no spend. Dart compiles in the viewer's browser, not on X99.

### Verdict

1. Cache the toolkit with a **service worker plus Cache Storage**, one entry per file keyed by its SHA-256. A warm visit downloads 0 bytes of toolkit. A toolkit bump downloads only the changed files (12,136 B for a changed `worker.js` and `sandbox.js`) and the page runs the new toolkit.
2. Preload level 2 (worker, `pub get`, toolkit fetch and a hidden connected sandbox at page open) cuts "frame opens" to "first frame" to **3.7 s** when the frame opens 15 s after the page (warm cache, 3 of 3 runs, 3.5 to 4.0 s). Level 1 (no hidden sandbox) does not help: about 11 s.
3. A warm visit is **not faster than a cold one** on X99 (p50 12.6 s warm, 13.0 s cold). Time to first frame is CPU (browser-side compile and boot), not download. Only preload hides it.
4. `pub.dev`, the Roboto fallback font and the rive runtime can be mirrored on X99. After that the viewer's browser calls no third-party host (assertion 6). Redirecting the hardcoded font and rive URLs needs the service worker.
5. S1b's "13.4 MB cold" left out `sdk.tar` (13.7 MB brotli, the browser often aborts it). The full cold toolkit is 44.2 MB offered by the server (31.3 MB toolkit plus 12.9 MB of `pub get` archives that a mirror makes the page fetch).

### 1. Test first: red on S1b, green on S2b

`s2b/check.mjs assert` runs a cold, a warm and a bumped-toolkit visit in one persistent profile. The server swaps `SDK_A` for a bumped `SDK_B` (changed `worker.js` and `sandbox.js`) between visits 2 and 3.

| #   | Assertion                                          | S1b page (red)                                     | S2b sw + mirror (green) |
| --- | -------------------------------------------------- | -------------------------------------------------- | ----------------------- |
| 1   | cold reaches a first frame                         | PASS                                               | PASS                    |
| 2   | warm visit downloads no toolkit asset              | PASS (0 B)                                         | PASS (0 B)              |
| 3   | after a bump the page runs the new toolkit         | **FAIL** (ran `84d633a69e12`, want `52c6aa63f4aa`) | PASS                    |
| 4   | after a bump only changed assets download (< 1 MB) | PASS (0 B, stale)                                  | PASS (12,136 B)         |
| 5   | page exposes a frame-open hook                     | **FAIL**                                           | PASS                    |
| 6   | viewer browser calls no third-party host           | **FAIL** (`pub.dev`, `fonts.gstatic.com`)          | PASS (none)             |

Why S1b fails 3: `max-age=86400` on a URL that is not keyed to content. A bumped toolkit is invisible to a returning visitor for up to 24 h. Assertion 4 passes there only because nothing new downloads.

Commands (run from `spikes/flutter-lane/s2b`):

```
node check.mjs assert --server s1b                                  # red, evidence-s2b/red-s1b.txt (2026-11-19 19:11 ICT)
node check.mjs assert --server s2b --mode http --query mirror=1     # evidence-s2b/assert-mirror-http.txt
node check.mjs assert --server s2b --mode sw   --query mirror=1     # green, evidence-s2b/green-sw.txt (23:21 ICT, after the quota fix in section 6)
```

Files, in the order they were produced:

1. `red-s1b.txt`: the red above (19:11 ICT).
2. `assert-first-http.txt` (19:20) and `assert-first-sw.txt` (19:27): S2b without the mirror. Assertions 1 to 5 as in the table; assertion 6 FAILS (`pub.dev`, `fonts.gstatic.com`).
3. `assert-mirror-http.txt` (19:54): mirror on, `http` mode. Assertion 6 FAILS on `fonts.gstatic.com`: only the service worker can redirect that hardcoded URL. Expected, and the reason `http` mode loses.
4. `assert-mirror-sw.txt` (19:48): mirror on, `sw` mode, an intermediate run. Assertion 6 FAILED on `fonts.gstatic.com` because `check.mjs` counted a request the service worker had answered from the mirror as third-party. I fixed the count (a service-worker-answered request goes to X99 only) and re-ran.
5. `green-sw.txt` (23:21): the final green, all six PASS.

### 2. Cache approach: service worker, keyed by version and SHA-256

Two approaches built and measured:

|                              | `http`: immutable URL                                                                         | `sw`: service worker + Cache Storage (chosen)                               |
| ---------------------------- | --------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------- |
| Key                          | `/sdkh/<key>/`, key = first 16 hex of SHA-256 over the file manifest; `max-age=1y, immutable` | cache name `toolkit-0.1.4-3.14.0-3.50.0`; entry `/sdks/<file>?sha=<sha256>` |
| Warm visit                   | 0 B                                                                                           | 0 B                                                                         |
| Bump                         | whole toolkit again: 31,329,131 B (new URL base)                                              | changed files only: 12,136 B in 2 requests                                  |
| Hardcoded font and rive URLs | cannot redirect                                                                               | redirected to the X99 mirror                                                |
| Stale toolkit after a bump   | none (new URL)                                                                                | none (manifest checked on every visit, no-store)                            |
| Needs                        | nothing in the page                                                                           | `/sw.js` (no-store), `/sdks/manifest.json` (no-store)                       |

Why `sw`: the toolkit is 12 files of very different size and only two (`worker.js`, `sandbox.js`) changed in the bump. Per-file keys re-download 12 KB where a content-hashed base directory re-downloads 31 MB. The service worker is also the only place the hardcoded `fonts.gstatic.com` and `cdn.jsdelivr.net` URLs can be rewritten. Cost: a registered service worker, one small no-store manifest request per visit, and a first load that must wait for the worker to take control (`page.js` waits for `controllerchange`).

The service worker controls the srcdoc sandbox iframe and the blob module worker too. Both reached a first frame.

Stale cleanup: `activate` deletes caches whose name differs from the current `toolkit-<dartpad>-<dart>-<flutter>`. Inside a cache, a changed file's old hash entry is deleted before the new one is stored.

Manifest: `/sdks/manifest.json` lists `{path: sha256}` for the 12 files the browser can fetch at run time (no `.map`, no `devtools/`). The bumped SDK_B changes `worker.js` (`52c6aa63f4aad1cad126f501a8f7cdaf61107c843fde01cd27332e5d9fd8737d`) and `sandbox.js` (`481f6b0badcb8df1d659155e33ae881d7b64c6bbae43202587a7658e0945092c`).

### 3. Preload: frame opens 0, 5 and 15 s after the page

`page.js` flag `preload=0|1|2` and `frameAt=<ms>`; `window.s2b.openFrame()` opens the Flutter frame. Levels: 0 starts everything when the frame opens. 1 starts the worker, `pub get` and the toolkit fetch at page open. 2 also boots a hidden sandbox iframe and connects it.

Metric: ms from "frame opens" to the first `doop:flutter-frame` message. 3 runs per cell, fresh profile each (cold) or one prior visit (warm). Host load was 5 to 27 (shared host), so each cell lists its 3 runs.

Cold cache (service worker, mirror on):

| Level | Frame opens at 0 s | at 5 s             | at 15 s               |
| ----- | ------------------ | ------------------ | --------------------- |
| 0     | 11.9, 12.0, 72.9 s | 12.5, 13.9, 65.1 s | 12.8, 44.6, 150.8 s   |
| 1     | 14.1, 14.1, 28.2 s | 10.2, 17.2, 56.3 s | 11.0, 11.2, 28.5 s    |
| 2     | 14.4, 15.6, 69.2 s | 10.3, 50.3, 85.6 s | **3.5, 3.6**, 106.9 s |

Warm cache (service worker, one prior visit):

| Level | Frame opens at 0 s | at 5 s             | at 15 s             |
| ----- | ------------------ | ------------------ | ------------------- |
| 0     | 12.1, 12.8, 13.1 s | 12.0, 12.5, 12.8 s | 12.6, 14.1, 14.2 s  |
| 2     | 8.7, 9.1, 25.6 s   | 3.9, 5.5, 41.8 s   | **3.5, 3.7, 4.0 s** |

Reading:

1. Level 2 works: with 15 s of head start the frame appears in 3.5 to 4.0 s (warm, 3 of 3) instead of 12 to 14 s. A 5 s head start gives 3.9 to 5.5 s when the host is quiet.
2. Level 1 buys almost nothing. Download and `pub get` are not the bottleneck; compile and sandbox boot are.
3. The large values (65 to 150 s) are host-load spikes: the same cell has runs at 12 s. They are kept in the table, not removed. Do not read a p50 from 3 runs under load as a budget.
4. Cold level 2 at 0 s (14.4 to 15.6 s) is a little slower than level 0 (12 s): the page competes with itself for the CPU while it boots the hidden sandbox. Preload helps only when the frame opens later than the page.

Files: `preload-cold-L0.txt`, `-L1`, `-L2`, `preload-warm-L0.txt`, `preload-warm-L2.txt` (start times 21:04 to 22:22 ICT). Command: `node check.mjs preload --server s2b --mode sw --level N --delays 0,5000,15000 --runs 3 [--warm 1] --query mirror=1`, driven by `s2b/run-preload.sh`.

### 4. Mirror: `pub.dev`, fonts, rive runtime on the X99 static host

Mirrorable. All three are served by `/mirror/*` on the same X99 origin (filled once, at build time, from X99 by `s2b/mirror.mjs`; the viewer's browser never calls the originals).

| Source              | What                                                                                                                                          | On X99                               |
| ------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------ |
| `pub.dev`           | package JSON (`archive_url` rewritten to the request's own origin) and archives for every package the probes resolve (rive probe, erus probe) | 82 files, 38 MB for the whole mirror |
| `fonts.gstatic.com` | Roboto v32 fallback font `KFOmCnqEu92Fr1Me4GZLCzYlKw.woff2`                                                                                   | 63,464 B                             |
| `cdn.jsdelivr.net`  | `@rive-app/flutter-native-wasm@44.0.0`: `rive_native.js` 226,241 B, `rive_native.wasm` 2,856,401 B                                            | 2 files                              |

How the page reaches them:

1. `pub.dev`: `Worker.create({pubHostedUrl})` with `?mirror=1`. No service worker needed.
2. Font and rive: the toolkit hardcodes both URLs. The service worker answers them from `/mirror/fonts` and `/mirror/jsdelivr`. In `http` mode the font is still fetched from `fonts.gstatic.com` (assertion 6 is INFO there, `assert-mirror-http.txt`).

Limits, recorded:

1. The mirror holds only the packages named in `evidence-s2b/third-party-urls-*.txt` and `mirror-urls.txt` (86 URLs). A new package needs one more `mirror.mjs` run on X99. The first mirror run missed 32 archives (404 with a custom `pubHostedUrl`); they were harvested into `third-party-urls-erus-archives.txt` and the mirror rebuilt.
2. The rive redirect rule and files exist, but no rive frame was run end to end in this spike: CHE-7353 owns the Rive shell, slot and harness, so I did not touch them. The probe's third-party URLs are in `third-party-urls-riv.txt`. Next check belongs to that issue.
3. Mirroring makes `pub get` download archives it did not need from `pub.dev` JSON alone: about 12.9 MB extra for the erus probe. It stays on X99.

### 5. Measure: 5 runs each of cold, warm second visit, warm after a toolkit bump

`node check.mjs visits --server s2b --mode sw|http --runs 5 --query mirror=1`, driven by `s2b/run-measure.sh`. S1b baseline: `node check.mjs visits --server s1b --runs 5`. Time is page open to first frame. Bytes are what the server offered (`STATS_FILE`), plus Playwright's own count in the raw files.

| Setup                                    | Visit | Time to first frame p50 |     max |                    Toolkit bytes |
| ---------------------------------------- | ----- | ----------------------: | ------: | -------------------------------: |
| S1b baseline (22.8 load, 20:03 ICT)      | cold  |                  12.9 s |  31.6 s |  16.3 MB (Playwright count, p50) |
|                                          | warm  |                  12.9 s |  32.1 s |                                0 |
|                                          | bump  |                   9.8 s |  41.6 s | 0, **old toolkit still running** |
| S2b `http` + mirror (load 11, 20:23 ICT) | cold  |                  12.5 s |  16.0 s |                       44,181,401 |
|                                          | warm  |                  12.4 s |  42.2 s |                                0 |
|                                          | bump  |                  11.0 s |  12.0 s |                       31,329,131 |
| S2b `sw` + mirror (load 13, 20:42 ICT)   | cold  |                  13.0 s |  67.5 s |                       44,244,865 |
|                                          | warm  |                  12.6 s |  54.0 s |                                0 |
|                                          | bump  |                   8.5 s | 100.3 s |              12,136 (2 requests) |

Notes:

1. Max values above 40 s are host-load spikes (shared X99, load 11 to 58 across the day). p50 of 5 is the number to read, and even that moves by seconds with load.
2. "Offered" is not "delivered": the browser aborts `sdk.tar` (`ERR_ABORTED`) in some visits, so finished bytes are about 13.7 MB lower (`http` cold: 44.18 MB offered, 30.5 MB finished).
3. Warm time equals cold time. The download is not the cost.
4. The warm `sw` visit still sends one small `no-store` manifest request. It is not counted as toolkit (it is how a bump is seen).

Files: `measure-s1b-baseline.txt`, `measure-s2b-http.txt`, `measure-s2b-sw.txt` (per-run lines and the SUMMARY lines).

### 6. Storage per origin, clear and eviction

Storage (`navigator.storage.estimate().usage`, `sw` mode, Chrome 158): **about 252.5 MB** after a cold visit, **about 327.9 MB** after the first warm visit, 328.7 MB after a bump. The cold-to-warm jump of about 75 MB was not investigated (it repeats in every run: 252.52 then 327.88 MB). Plan for the larger figure; either is large for a phone browser. Real devices are not reachable from X99, so no phone number was measured.

`node check.mjs evict --server s2b --mode sw --query mirror=1 [--only B,C,D|E]` (one profile per scenario):

| Scenario                                                           | What happened                                                                                                                                    | Result          |
| ------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------ | --------------- |
| A baseline                                                         | cold 44,244,865 B; warm 0 B; 12 cache entries                                                                                                    | PASS            |
| B Cache Storage cleared (service worker stays)                     | first frame reached; **31,329,091 B in 12 requests** (the toolkit; `pub get` archives came from the HTTP cache); 12 entries back; next visit 0 B | PASS            |
| C all site data cleared (service worker unregistered)              | first frame reached; 31,329,091 B in 12 requests; next visit 0 B                                                                                 | PASS            |
| D partial eviction, 5 entries dropped (`canvaskit/` and `assets/`) | first frame reached; **3,698,692 B in 5 requests** (only the dropped files); 12 entries back                                                     | PASS            |
| E origin quota 100 MB (less than the toolkit)                      | see below                                                                                                                                        | red, then green |

E found a real bug. With `Storage.overrideQuotaForOrigin` set to 100 MB, `cache.put` throws `QuotaExceededError`. The service worker awaited it inside `respondWith`, so that file's fetch failed and the page never reached a first frame (240 s timeout, both visits): `evict-red-E.txt`, run against the pre-fix `sw.js` (23:13 ICT). Fix, `page/sw.js`: `await cache.put(key, r.clone()).catch(() => {})` (serve from the network, keep what fits). Green, `evict-green-E.txt` (23:17 ICT): first visit reaches a first frame (87.9 s under load 6 to 20), 9 of 12 entries cached, storage 99.83 MB; second visit reaches a first frame in 11.3 s and re-downloads the 3 uncached files (12,664,112 B). Below the quota the toolkit works but never fully warms.

Behaviour summary:

1. Cleared or evicted cache: the page works, re-downloads only what is missing, and is warm on the next visit.
2. Quota too small: the page works but part of the toolkit downloads on every visit.
3. Browser eviction is best effort. `navigator.storage.persist()` was not requested in this spike; asking for it is a product choice (a permission prompt on some browsers) and is left open.

Run notes: B, C and D ran in one call (`evict-green-BCD.txt`, 23:25 ICT); the last visit of D ("next visit is warm again") crashed the browser under load (`page.waitForTimeout: Target page, context or browser has been closed`), so that one check has no result in that file. D was re-run alone on the final code: `evict-green-D.txt` (23:39 ICT), all four checks PASS, including "next visit is warm again". An earlier D-only run on the pre-fix `sw.js` (`evict-red-D.txt`, 23:04 ICT) also passed.

### 7. Pinned toolkit digests (from S1b)

`package:dartpad` 0.1.4, Dart 3.14.0, Flutter 3.50.0. SHA-256 of the files the page fetches (the `s2b` manifest uses these):

| File                       | SHA-256                                                            |
| -------------------------- | ------------------------------------------------------------------ |
| `worker.js`                | `84d633a69e12f96cb61a46aac4f95e664cd9d779875665795ab701e80892dd21` |
| `worker.wasm`              | `a7cab6f3036ad024adb6f5b77443735a527b2d736eb05f0877ac501577e9675e` |
| `dart_sdk.js`              | `1d43dc0affb9ac248f674645c8aefc339f00dc2330f66b1016d31e4778f27005` |
| `flutter_web.js`           | `5d5d5c3c105efc27bf0dbc57d683059c79fc4c0549da89151fe688122fb0f15c` |
| `sdk.tar`                  | `5529c55a7c27d3110c8c71a1b5f96c3bc1b9c05dbeaa5b8fccc5b4cfc3115299` |
| `sandbox.js`               | `040a85950acd2bb468108360982ba5fd8dc36903f9511264e8dc0b12fe1d864b` |
| `sandbox_runtime.js`       | `f9bbbf7e58b623fa9a5f88d7a6d4c2d3d958119b46e7dec6273b4d8435c18476` |
| `canvaskit/canvaskit.wasm` | `f3c2ff164f324217ebe1d84900110e425c0195fc63f34e8b58de842a047e0c1c` |
| `canvaskit/canvaskit.js`   | `4719b51c8e2a4e2371c3b35286db039efdf76dcf7459fb810bf5fccaa22ee36c` |

Bump used in the tests: changed `worker.js` and `sandbox.js` only (digests in section 2); everything else is a symlink to the same files.

### What is in the PR

1. `spikes/flutter-lane/s2b/`: `serve.ts` (S1b server plus `/sdkh/`, `/sdks/`, `/sw.js`, `/mirror/*`, byte stats), `page/` (`index.html`, `page.js`, `sw.js`), `check.mjs` (suites `assert`, `visits`, `preload`, `evict`), `mirror.mjs`, `urls.mjs`, `dbg.mjs`, `run-measure.sh`, `run-preload.sh`.
2. `spikes/flutter-lane/evidence-s2b/`: the raw outputs named above.
3. This file.

Not changed: the Rive shell, slot and harness; `s1b/`; C00; any public surface.

### Caveats

1. X99 is shared. Load averaged 5 to 34 during the runs. p50 values move by seconds; max values are load. Re-run on a quiet host before using any number as a budget.
2. Chrome only, headless, on X99. No Safari, no Firefox, no phone. Safari evicts script-writable storage after 7 days without a visit (ITP); not tested.
3. Bytes are the server's offered count. Delivered bytes are lower when the browser aborts `sdk.tar`.
4. The rive redirect is not exercised end to end (section 4).
5. `playwright-core` is resolved from `/home/congvc/node_modules` by a symlink in `s2b/node_modules`; the symlink is not committed.
