# S1 evidence: Flutter web hot-reload loop inside a doop frame

Issue CHE-7352 (stage 1 of CHE-7351). Run 19 Nov 2026, 01:30 to 03:45 ICT, on X99. Evidence only: this PR is closed, not
merged, after S3 reads it.

**Verdict for Cheese to judge:** the edit loop is fast enough on paper. Save to visible frame is p50 348 ms, max 492 ms in
the target frame form (n=20). The post-frame message under-reports the pixels by about 100 to 130 ms, so the visible p50 is
about 450 to 480 ms. The target was 1 s or less. Cheese judges feel; this page only records numbers.

## 1. What was built

| Part                  | Where                                                         | Notes                                                                                               |
| --------------------- | ------------------------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| Screen                | `app/lib/main.dart`                                           | erus Home (CHE-6290 round 1) as a Flutter widget, fake data, a tap counter for the state-kept check |
| Ready signal          | `app/lib/bridge.dart`                                         | posts `doop:flutter-ready` once and `doop:flutter-frame` after each frame, via `postMessage`        |
| Harness               | `harness/*.mjs`, `harness/*.ts`, `harness/*.sh`               | Playwright-core + bun; every script is listed in section 9                                          |
| Frame form 1 stand-in | `harness/serve.ts` `/player?form=nested`                      | the real `FRAME_BOOTSTRAP` from `src/lib/frameRuntime.ts` in a `sandbox="allow-scripts"` srcdoc     |
| Frame form 2 page     | `harness/serve.ts` `/player?form=kind&sandbox=<flags>&src=..` | direct iframe, the proposed new frame kind                                                          |

Assumptions to check at review:

- The Home screen was rebuilt from the CHE-6290 S2 spec text. I could not read the HTML frames themselves.
- SF Pro is not used. The screen renders with the Flutter default (Roboto). Nothing proprietary is in the repo.
- Chrome 158 headless (Playwright chromium-1254) is the only browser tested. Safari and iPhone are untested, see section 5.

## 2. Pins (step 1)

| Item           | Value                                                                                                                                             |
| -------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| Flutter SDK    | 3.50.0 stable (Dart 3.14.0, engine bf601093ad), the latest stable on 19 Nov 2026 ICT; installed outside the repo in `/mnt/ssd2/scratch/che-7352/` |
| Renderer, dev  | CanvasKit (debug JS build served by `flutter run -d web-server`)                                                                                  |
| Renderer, wasm | skwasm (`--wasm`); the app reports it from `kIsWasm`, see `env` lines in `evidence/release-matrix.txt`                                            |
| Browser        | Chrome 158 headless, device scale factor 3, viewport 390x844                                                                                      |

## 3. The edit loop (steps 2 and 3)

How it runs (`harness/live.sh start` wraps all of it):

1. `flutter run -d web-server --web-hostname <tailnet IP> --web-port 18451 --hot --pid-file ...` with a `tailscale cert` for TLS.
   Bound to `100.117.164.34` only, checked with `ss -ltn`. Never `0.0.0.0`, no funnel.
2. `harness/watch.mjs`: `fs.watch` on `app/lib`, 20 ms trailing debounce, then `kill -USR1 <flutter pid>` (hot reload).
3. The app posts `doop:flutter-ready` after its first frame, `doop:flutter-frame {stamp, taps, ts}` after each frame.
4. `harness/timing.mjs`: writes the Dart file at t0, takes `ts` of the first frame carrying the new stamp. Saves are
   `kBuildStamp` edits, restored after.

All 20 values, ms, form 2, HTTPS, CanvasKit, cold dev server, 02:17 ICT (`evidence/timing-form2.txt`):

`492 386 323 353 361 378 317 391 348 354 290 333 330 326 319 366 356 352 326 324` → **p50 348, max 492**

Same in no frame (top-level page, HTTPS, `evidence/timing-toplevel-https.txt`), 02:18 ICT:

`488 401 341 378 348 362 379 310 367 316 352 355 375 375 355 339 306 341 354 310` → p50 354, max 488

Pixel cross-check (`evidence/pixel-crosscheck-form2.txt`): a colour band derived from the stamp is polled by screenshot. The
pixels changed 623, 519, 456, 487, 473 ms after save, against 489, 396, 341, 385, 362 ms for the message. The message is early by
about 100 to 130 ms.

State is kept (`evidence/green.txt`): two taps (taps=2), save a Dart edit, the next frame has taps=2 and the new stamp.

Caveats on these numbers:

- Host load was high the whole time (load average 11 to 14 at 02:17 ICT; 44 to 64 at 03:26 ICT, other agents' builds). Treat as
  upper bounds.
- Save to trigger (20 ms debounce plus inotify) is inside the numbers. It was not logged separately.
- A first series with an unfixed watcher is kept as a record of the failure mode
  (`evidence/timing-toplevel-canvaskit.txt`, p50 638, max 1797): each save sent two reload signals (truncate and write), which
  queued reloads. The 20 ms debounce fixed it.
- Release builds have no hot reload. This section is the debug dev server.

## 4. Frame forms (step 4)

| Row                                 | Form 1: nested iframe in the HTML frame                                                                                                                                                                                                         | Form 2: own frame kind, `sandbox="allow-scripts allow-same-origin"` (target)                                                                                          |
| ----------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Dev edit loop (DWDS)                | **Blocked.** Opaque origin, `sessionStorage` throws `SecurityError` in the injected `client.js`. App never starts. (`evidence/forms-dev-canvaskit.txt`)                                                                                         | Works, section 3                                                                                                                                                      |
| Release build                       | Works only with two changes: a custom `web/flutter_bootstrap.js` without the service worker (the stock one reads `navigator.serviceWorker`, which throws in a sandboxed frame), and `Access-Control-Allow-Origin` on every asset (see CORS row) | Works with the stock bootstrap and no extra headers                                                                                                                   |
| Ready signal reaches the player     | Only through the frame runtime relay. With the relay off, the player gets nothing (player accepts only the frame iframe's own window, `PrototypePlayer.tsx:527-528`)                                                                            | Direct: the app window is the iframe's own window, no relay                                                                                                           |
| CORS on asset fetches               | Needed. App origin is `null`. Without ACAO: CanvasKit dies on `assets/FontManifest.json`, skwasm on `main.dart.mjs`. With `ACAO: *`: both work                                                                                                  | Not needed for the app's own assets (same origin)                                                                                                                     |
| Storage                             | `localStorage` blocked (`"blocked"` in the ready message)                                                                                                                                                                                       | `localStorage` ok, scoped to the app origin                                                                                                                           |
| Cross-origin isolation for skwasm   | Never: `crossOriginIsolated=false` even with an isolated player                                                                                                                                                                                 | `true` only if the doop page itself sends COOP `same-origin` + COEP `require-corp` AND the app sends CORP `cross-origin`. Without CORP the frame is blocked           |
| skwasm without isolation            | Runs (renderer reports skwasm)                                                                                                                                                                                                                  | Runs (renderer reports skwasm)                                                                                                                                        |
| Mixed content (doop on C00 = HTTPS) | Same as form 2                                                                                                                                                                                                                                  | Chrome 158 loaded the HTTP app under an HTTPS page and only warned (`evidence/mixed-content.txt`). Do not rely on it; Safari untested. TLS here is a `tailscale cert` |
| Reach from MacBook and iPhone       | Not tested, section 5                                                                                                                                                                                                                           | Not tested, section 5                                                                                                                                                 |

Security note for the new frame kind: `allow-scripts` plus `allow-same-origin` is only safe when the framed origin differs from
the embedding doop origin. The app must live on its own origin (here a different port on X99), never on doop's.

Cross-origin isolation costs: COOP/COEP on doop's own page means every other cross-origin resource on that page (images, fonts,
other frames) must send CORP or CORS. That is a product-wide change for a speed gain on skwasm only. skwasm runs without it.

## 5. Reach from MacBook and iPhone (step 4, not verifiable from X99)

- 19 Nov 2026 about 02:00 ICT: `tailscale ping macbook-air-ca-trn` answered through DERP (hkg) in 679 ms, no direct path.
- 03:15 ICT: `macbook-air-ca-trn`, `macbook-pro` and `iphone` all show offline in `tailscale status`.
- So no device test was possible. The frame link is tailnet-only; Cheese must be on the tailnet. Safari behaviour (mixed content,
  `postMessage`, WebGL) is unverified. This is left to Cheese at the gate.

## 6. Concurrent instances (step 5)

Dev server, form 2 policy, 3 instances in one page, 02:42 ICT (`evidence/concurrent-3.txt`, 5 runs):

| Result                                                           | Observed                                                                                                                                                                                                                                |
| ---------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Which instances get a hot reload                                 | **One only: the last one that connected** (instance 2; after a remount of instance 0, instance 0). The other two keep running the old code. 5 of 5 runs, 1 run where instance 2 never started and instance 1 got it                     |
| State after remount                                              | Gone (taps 2 → 0). New instance starts from the current code. First frame 4.3 to 7.1 s after remount (5 runs: 5.7, 5.8, 4.3, 7.1, 5.9 s)                                                                                                |
| Start 3 at once                                                  | Chrome refuses most of the ~927 unbundled debug scripts per instance: `ERR_INSUFFICIENT_RESOURCES` 1296 to 1629 times. Mostly recovers: 3 of 3 ready in 14.6 s, but in 1 of 3 runs only 2 of 3 were ready after 40 s                    |
| Start 3, 4 s apart                                               | 0 failed requests, 3 of 3 ready in 14.2 to 15.4 s (3 of 3 runs)                                                                                                                                                                         |
| WebGL context limit, release builds (`evidence/webgl-limit.txt`) | CanvasKit: clean at 4 instances, "Too many active WebGL contexts. Oldest context will be lost" from 5. skwasm: clean at 16, from 17. All instances still posted a first frame. Whether a context-lost instance repaints was not checked |

So the 3-instance matrix row plus canvas plus player (5 instances) is at the CanvasKit limit. skwasm has room.

Not tested: hot restart instead of reload, one dev server per instance, running only one instance in dev and the others as
release builds.

## 7. Release build (step 6)

`flutter build web --release [--wasm] --no-web-resources-cdn`, built on X99 under load 14: CanvasKit 112.7 s compile (2 m 02 s
wall), skwasm 57.7 s (1 m 01 s wall). Served by `harness/static.ts` over HTTPS on the tailnet IP.

Bytes on one cold first load, uncompressed (`evidence/release-bytes.txt`):

| Build            | Total       | Biggest parts                                                                 |
| ---------------- | ----------- | ----------------------------------------------------------------------------- |
| CanvasKit, local | 7,789,708 B | `canvaskit.wasm` 5,463,539, `main.dart.js` 2,066,091, fallback Roboto 171,676 |
| skwasm, local    | 5,510,655 B | `skwasm.wasm` 3,612,036, `main.dart.wasm` 1,631,621, fallback Roboto 171,676  |

The default build (`--web-resources-cdn` is on by default) loads CanvasKit and Roboto from `gstatic.com` at runtime, a public
CDN hop on every first load. The final numbers use `--no-web-resources-cdn`.

First frame from navigation start, cold, ms (`evidence/release-matrix.txt`). The host was loaded (load average 44 to 64 for the
interleaved series), so the minimum is the best signal:

| Series                                                    | CanvasKit p50 (min to max) | skwasm p50 (min to max) |
| --------------------------------------------------------- | -------------------------- | ----------------------- |
| Form 2, interleaved, 8 pairs, load 44 to 64               | 2168 (1720 to 6670)        | 1634 (1148 to 5170)     |
| Form 2, 5 runs                                            | 2866 (2525 to 4263)        | 1150 (1009 to 3397)     |
| Form 1 (+CORS, no SW), 5 runs                             | 1768 (1640 to 1824)        | 1161 (1079 to 1561)     |
| Top-level, 5 runs                                         | 5726 (2223 to 12813)       | 2505 (2327 to 4693)     |
| Form 2 + isolated player, 3 runs                          | -                          | 706 (687 to 719)        |
| Earlier, CDN default build, load about 14, form 2, 5 runs | 1822 (1739 to 1916)        | 1459 (1387 to 1576)     |

skwasm is faster to first frame than CanvasKit in every pairing. The spread is noise from the host, not from the build.

## 8. Agent screenshot of the current build (step 7)

```
node harness/shot.mjs "<frame url>" out.png
```

Headless Chrome via Playwright: waits for `doop:flutter-ready`, 500 ms, then `page.screenshot`. About 7.5 s end to end
including load on this host. Output: `evidence/shot-form2.png` (form 2) and `evidence/shot-toplevel.png` (top-level); the two are
byte-identical, so the frame adds no visual change.

## 9. Test-first (red, then green)

- Red, 02:05 ICT, against an empty page with no app (`evidence/red.txt`): `ready-check.mjs` exit 1, `timing.mjs` failed.
- Green, 03:15 ICT, same scripts against the dev server in form 2 (`evidence/green.txt`): ready after 6631 ms, exit 0;
  `state-check.mjs` taps 2 → 2 after reload, exit 0.

| Script              | Purpose                                                                |
| ------------------- | ---------------------------------------------------------------------- |
| `ready-check.mjs`   | exit 0 when the app posts `doop:flutter-ready`                         |
| `timing.mjs`        | N saves, save to first frame with the new stamp, p50 and max           |
| `state-check.mjs`   | tap twice, save, assert state kept                                     |
| `watch.mjs`         | file watcher, sends the reload signal                                  |
| `pixel-check.mjs`   | pixel cross-check of the message time                                  |
| `env-check.mjs`     | origin, storage, isolation, renderer as the app sees them              |
| `multi-check.mjs`   | N concurrent instances: ready, hot-reload target, remount, WebGL limit |
| `release-check.mjs` | cold first frame of a release build, per frame form                    |
| `bytes-check.mjs`   | bytes on a cold first load                                             |
| `mixed-check.mjs`   | mixed-content behaviour with Chrome's stock policy                     |
| `shot.mjs`          | agent screenshot                                                       |
| `dev.sh`, `live.sh` | dev server and the whole live loop (start, stop, status)               |
| `serve.ts`          | frame-form player pages                                                |
| `static.ts`         | static HTTPS server for release builds (CORS and COOP/COEP switches)   |

## 10. Housekeeping

- No secrets or certificates in the repo. The TLS cert and key live in `/mnt/ssd2/scratch/che-7352/cert/`.
- Nothing public: every listener is on the tailnet IP or `127.0.0.1`; `tailscale serve` is tailnet-only; no funnel; no C00 change.
- `df -B1 /mnt/ssd2`: before 02:00 ICT, used 330,347,008,000, available 146,953,166,848. After cleanup: see the PR comment on
  the issue.

## 11. Round 2: Cheese answered "chưa đạt" (19 Nov 2026 08:57 ICT)

Cheese's words: the load time is over 5 minutes; Flutter code must be compiled somewhere; compile in the client's browser, not on our servers.

**Cause found (measured 09:00 to 09:17 ICT, X99 load average 55 to 62).** The first load of the dev build is 942 requests and
about 56 MB on the wire (`evidence/load-budget-red.txt`; `dart_sdk.js` alone 17.3 MB, `material/icons.dart.lib.js` 8.2 MB).
The dev server sends no compression. Cheese's MacBook Pro reaches X99 through the Tailscale relay `sin` (`tailscale status`, not
a direct path), so the wire is the bottleneck, not X99. On X99 itself the same load is 22 s. Section 7 had measured release
builds only (7.8 MB); nobody had measured the dev build's first load before this round.

**Fix:** `harness/devproxy.ts`, an HTTPS proxy on the tailnet IP in front of the dev server (which now binds `127.0.0.1:18461`,
plain http). It gzips text responses (cached per URL and etag), passes websockets through and rewrites the address DWDS bakes into
`main_module.bootstrap.js`. `live.sh` starts it.

|                             | before                                                   | after                                                     |
| --------------------------- | -------------------------------------------------------- | --------------------------------------------------------- |
| Wire bytes, cold first load | 55,792,161 (`load-budget-red.txt`, exit 1, budget 20 MB) | 9,439,418 (`load-budget-green.txt`, exit 0)               |
| Ready on X99, load 55 to 62 | 21.9 s (warm server)                                     | 49.3 s (first load after a server restart; includes gzip) |

Test-first: `harness/load-budget.mjs` (new) asserts wire bytes under a budget and the ready signal. Red 09:03 ICT, exit 1; green
09:16 ICT, exit 0. Both with the budget 20,000,000.

**Edit loop after the proxy** (`evidence/timing-form2-proxy.txt`, `evidence/state-proxy.txt`): state is kept (taps 2 → 2).
20 saves: **p50 2020 ms, max 4025 ms**, at load average 62. Round 1 was p50 348 ms at load 11 to 14. The Flutter log reports its own
reload at 870 to 3020 ms for the same saves, so the time is the compile on a loaded host, not the proxy. Same machine, not the
same load: this is not a like-for-like comparison.

**On "compile in the client's browser".** Not possible with stock Flutter: the build tools (`frontend_server`, `dartdevc`,
`dart2js`) run on the Dart VM, and there is no browser-side Dart compiler in the SDK. The browser runs the compiled JavaScript or
wasm. Compiling somewhere else than X99 means the MacBook (the client machine runs the Flutter SDK and serves the dev server)
or a build host; that is a product-direction choice, put to Cheese on the decision card.

**Not fixed, not measured:** the first load still pulls 9.4 MB; icon libraries (about 12 MB raw) dominate and could shrink with
a smaller icon set. A release build is 7.8 MB raw but has no hot reload (section 6). Cheese's own second load was not measured.
