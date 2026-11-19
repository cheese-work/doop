# S1b evidence: compile and hot-reload Flutter in the viewer's browser (CHE-7478)

Spike only. Evidence PR, closed not merged. Stacked on S1 (PR 84, head `494b528c`).
Run on X99, 2026-11-19, 13:00 to 13:50 ICT. Browser measured: headless Chrome 158 on X99 (Playwright, `chromium-1254`). X99 load average during the runs: 9 to 12 for the repeat runs, 44 to 52 for the first runs (other agents share the host). Numbers from the busy period are marked.

## Verdict by step

| Step | Result |
| --- | --- |
| 1 pin + assets | Done. `package:dartpad 0.1.4`, Dart 3.14.0, Flutter 3.50.0. Sizes and SHA-256 below. |
| 2 serve | Done. Static from X99, tailnet IP only, TLS from `tailscale cert`. CanvasKit self-hosted. Two public origins still hit by the viewer's browser: `pub.dev` and `fonts.gstatic.com` (see "Network the viewer's browser makes"). |
| 3 frame form 2 | Works. erus Home from `app/lib/` arrives as text, one worker per page, one sandbox per frame. |
| 4 timing | Cold first frame 9.3 to 10.9 s (3 runs, load about 10). 20 of 20 edits visible, p50 658 ms, max 1071 ms, state kept (taps=2 every run). |
| 5 many frames | 1, 2, 3 sandboxes on one worker all work. Cost per extra frame is about 0.3 s per reload and about 0.7 GB Chrome RSS. |
| 6 browsers | Chrome on X99 only. MacBook Chrome/Edge, MacBook Safari, iPhone Safari NOT run: no access from X99. Blocked on a person with the devices. |
| 7 limits | `rive` compiles and draws. `FontLoader` from URL bytes works. `Semantics(identifier)` gives `flt-semantics-identifier`. |

No stop rule was triggered: dartpad runs Flutter in the browser end to end.

## 1. Pin and assets

Package: `package:dartpad` 0.1.4 (BSD-3, dart-lang/sdk `pkg/dartpad`). `version.json` of the built SDK:

```
dartVersion 3.14.0 (fa8c1270c374c1346931583a17c3b7f278d3822d)
flutterVersion 3.50.0 (ab2912035e160d9cad6306df307576da6128ebdb), engineRevision 371f77202a73e8dff57a8b3bff75bca55c090aee
```

What `dart run dartpad setup` does (observed; log in `/mnt/ssd2/scratch/che-7478/setup-flutter.log`): it takes a Flutter checkout, runs the Flutter web toolchain once, and writes the browser assets to one folder: `worker.js` + `worker.wasm` (the compiler, dart2wasm), `dart_sdk.js` (DDC runtime), `flutter_web.js` (Flutter framework compiled to JS), `sdk.tar` (SDK summaries the compiler reads), `sandbox.js` + `sandbox_runtime.js` (the iframe side), `canvaskit/`, `assets/` (fonts, NOTICES). It took longer than 590 s on X99 under load. This is the only compile on X99 and it is the framework, not product or prototype Dart. Product Dart is compiled in the viewer's browser.

Sizes. gzip level 9, brotli quality 9, taken on X99 (`/mnt/ssd2/scratch/che-7478/br-sizes.txt`).

| File | raw | gzip | brotli | SHA-256 |
| --- | ---: | ---: | ---: | --- |
| `worker.js` | 21,747 | 5,532 | 5,213 | `84d633a69e12f96cb61a46aac4f95e664cd9d779875665795ab701e80892dd21` |
| `worker.wasm` | 9,758,441 | 3,383,267 | 2,947,613 | `a7cab6f3036ad024adb6f5b77443735a527b2d736eb05f0877ac501577e9675e` |
| `dart_sdk.js` | 17,352,655 | 2,419,155 | 2,004,163 | `1d43dc0affb9ac248f674645c8aefc339f00dc2330f66b1016d31e4778f27005` |
| `flutter_web.js` | 129,868,847 | 13,419,410 | 8,890,551 | `5d5d5c3c105efc27bf0dbc57d683059c79fc4c0549da89151fe688122fb0f15c` |
| `sdk.tar` | 87,753,216 | 17,567,107 | 13,702,443 | `5529c55a7c27d3110c8c71a1b5f96c3bc1b9c05dbeaa5b8fccc5b4cfc3115299` |
| `sandbox.js` | 24,127 | 7,246 | 6,883 | `040a85950acd2bb468108360982ba5fd8dc36903f9511264e8dc0b12fe1d864b` |
| `sandbox_runtime.js` | 268,743 | 78,136 | 73,533 | `f9bbbf7e58b623fa9a5f88d7a6d4c2d3d958119b46e7dec6273b4d8435c18476` |
| `canvaskit/canvaskit.wasm` | 7,315,452 | 2,927,996 | 2,576,499 | `f3c2ff164f324217ebe1d84900110e425c0195fc63f34e8b58de842a047e0c1c` |
| `canvaskit/canvaskit.js` | 87,031 | 27,528 | 26,467 | `4719b51c8e2a4e2371c3b35286db039efdf76dcf7459fb810bf5fccaa22ee36c` |

Whole SDK folder 405 MB raw (includes `.map` files and `devtools/`, not fetched at run time). Measured on the wire for a cold load: 13.4 MB in 19 requests (`evidence-s1b/cold-warm.txt`). Second load in the same browser profile: 0.0 MB on the wire, 10 of 19 from disk cache (HTTP cache, `max-age=86400`).

## 2. Serving

`s1b/serve.ts`: Bun static server. Routes: `/sdk/*` (cacheable, br or gzip from an on-disk copy), `/src.json` and `/events` (source text, SSE on save), `/blob/*` (font and `.riv` bytes from a folder outside the repo), the page `no-store`. It refuses `0.0.0.0` and `::`. Listening socket, from `ss -ltn`: `100.117.164.34:19461` (the X99 tailnet address). TLS cert and key from `tailscale cert` for `congvc-x99.taila6fa8a.ts.net`, kept outside the repo. No public URL, no C00 change, no spend.

CanvasKit is self-hosted: requests go to `/sdk/canvaskit/` on the X99 host (`evidence-s1b/hosts-erus.txt`: 2 requests), not to `gstatic.com/flutter-canvaskit`.

## 3. Page (frame form 2)

`s1b/page/page.js` speaks the worker JSON-RPC from plain JS (no Dart compiled on X99 for the page): blob module worker importing `/sdk/worker.js`, `createWorkspace`, `writeFileFromText` for `pubspec.yaml` and each `lib/*.dart`, `pub get`, `connectSandbox` with a `srcdoc` iframe (`sandbox.js`), `sandbox/run` mode `flutter`, then `hotReload` on every `/events` push. The erus Home source is `../app/lib/` (the S1 app, unchanged). `?n=` sets the frame count. `?edit=1` adds a text box: typing hot reloads 150 ms after the last key (`evidence-s1b/typeedit.txt`: typed edit visible in 956 ms, status bar `reloaded in 780 ms`).

Test first. `s1b/check.mjs` and `s1b/probe.mjs` were run against an empty page or an empty source folder before the implementation existed. Red output: `evidence-s1b/red.txt` (load and edit) and `evidence-s1b/probe-red.txt` (font, sem, riv: `Compilation entrypoint ... lib/main.dart not found`, FAIL each). Green output is in the files named in the sections below.

## 4. Timing (headless Chrome 158, X99)

Cold first frame, empty HTTP cache, from `page.goto` to the first `doop:flutter-frame` message (`evidence-s1b/cold-warm-3x.txt`, load average 9 to 12):

| Round | cold | second load (same context) |
| --- | ---: | ---: |
| 1 | 9,440 ms | 9,947 ms |
| 2 | 9,338 ms | 10,493 ms |
| 3 | 10,943 ms | 9,026 ms |

Earlier runs under load 44 to 52 gave 10.5 s / 10.9 s and 18.4 s / 22.8 s (`timing-1frame.txt`, `cold-warm.txt`). Warm is not faster than cold: the time is CPU (parse of the 130 MB framework JS, wasm compile, DDC compile of the app), not download. The disk cache only removes the 13.4 MB transfer, which is small on a tailnet.

Edit to visible, 20 of 20 runs (`evidence-s1b/timing-1frame.txt`, 2026-11-19 13:12 ICT, busy host): 1071, 462, 377, 490, 398, 453, 525, 685, 658, 620, 735, 666, 782, 595, 782, 699, 644, 838, 672, 722 ms. p50 658 ms, max 1071 ms (run 1, first reload). The two taps before the edit stayed: `taps=2` in the frame message of all 20 runs, so hot reload kept state.

How the edit was timed: `check.mjs edit` rewrites `kBuildStamp = 'run-i'` in `main.dart` on disk, the server pushes the new text over SSE, the page writes it into the worker workspace and calls `sandbox/hotReload`, and the app posts a frame message with the stamp.

## 5. Two and three sandboxes on one worker

`s1b/multi.mjs`, 5 edits each (`evidence-s1b/multi.txt`, load average 43.7, busy host).

| Frames | all ready after | reload of frame 0 / 1 / 2 (typical) | JS heap | Chrome RSS (all processes of the run) |
| ---: | ---: | --- | ---: | ---: |
| 1 | 15.9 s | 0.4 to 0.7 s | 306 MB | 1,984 MB |
| 2 | 16.5 s | 0.35 to 0.57 s / 0.6 to 1.2 s | 405 MB | 2,718 MB |
| 3 | 18.0 s | 0.4 to 0.8 s / 0.65 to 1.0 s / 0.82 to 1.2 s | 444 MB | 2,674 MB |

- One worker and one `pub get` serve all frames. Adding a frame adds about 1.5 to 2 s to the ready time.
- Does one compile feed all frames? Not observed. `hotReload` is a call per sandbox, and the time to reload frame k grows by about 0.25 to 0.3 s per frame. That points to one compile per sandbox, run in sequence. I did not read the worker's internals to confirm. S2 can test a parallel call if this matters.
- Which frames reload: only the sandbox named in the call. Frames keep separate state (`taps=2` in frame 0 where I tapped, `taps=0` in frames 1 and 2).
- Memory: about 0.7 GB more Chrome RSS for the second frame, about the same for the third (RSS noise is large; one sample each).

## 6. Browsers

| Browser | Result |
| --- | --- |
| Chrome headless 158 on X99 | Works, all numbers above. |
| Chrome / Edge on MacBook | NOT RUN. No access from X99. |
| Safari on MacBook | NOT RUN. Same. |
| Safari on iPhone | NOT RUN. Same. |

Reachability probe from X99: the MacBook SSH login was refused (`Permission denied (publickey)`; I did not work around it). `tailscale status`: `macbook-pro` shows active but this agent has no login on it, `macbook-air-ca-trn` offline 51 minutes, `iphone` listed with no live connection. Only a person holding the device can open the link. The URL is in the Cheese gate comment; the page runs with `?edit=1` for an edit check. What to report from Safari: does the frame appear, does the log line at the bottom say `FAILED`, and the error text. Known risk, not tested: `SharedArrayBuffer` and wasm GC support differ in Safari, and the worker is dart2wasm.

## 7. Limits

### 7a. `rive` (0.14.11, from pub.dev)

Probe `s1b/probes/riv/lib/main.dart`: fetch `rocket.riv` bytes (4,598 bytes, from `/blob/rocket.riv`, the file is from the pub.dev `rive` 0.14.11 archive `example/assets/`), `RiveNative.init()`, `File.decode(bytes, riveFactory: Factory.rive)`, `RiveWidget`. Result: `doop:flutter-probe {"ok":true,"bytes":4598}` and the frame shows an arrow icon in a rounded square (`evidence-s1b/shot-riv.png`). `rive` compiled under DartPad although it depends on the plugin `rive_native` 0.1.11 and the DartPad README says no Flutter plugins. Observed: `pub get` resolved it and the DDC compile passed. I did not read why; it may be that `rive_native` is pure Dart on web. One file tested (one small icon, one artboard). Not tested: state machines with input, larger files, `Factory.flutter`.

Cost: at run time the page requests `https://cdn.jsdelivr.net/npm/@rive-app/...` (2 requests, `evidence-s1b/hosts-riv.txt`; I did not inspect the bodies, probably the Rive wasm). That is a public CDN call from the viewer's browser. I did not check whether it can be pointed at a self-hosted copy.

### 7b. FontLoader from URL bytes

Probe `s1b/probes/font/lib/main.dart`: fetch TTF bytes from `/blob/DejaVuSerif.ttf` (380,660 bytes), `FontLoader('Probe')..addFont(...)`, `load()`. Text width of the same string at 40 px with family `Probe`: 407.9 before load, 467.6 after load, so the font is applied. PASS (`evidence-s1b/shot-font.png`). SF Pro was not used: it is not on X99 and must never be committed or uploaded. A stand-in (DejaVu Serif, from `/usr/share/fonts`) proves the mechanism. The route for SF Pro is the same `/blob/<name>` from a folder outside the repo; the person with the font puts the file there.

### 7c. `Semantics(identifier)`

Probe `s1b/probes/sem/lib/main.dart`: `SemanticsBinding.instance.ensureSemantics()` then `Semantics(identifier: 'doop-probe-id', label: 'probe', button: true, ...)`. The DOM of the sandbox iframe (searched through open shadow roots) has `flt-semantics-identifier="doop-probe-id"`. PASS. Semantics must be switched on with `ensureSemantics()`; without it the placeholder tree is not built (not tested without).

## Network the viewer's browser makes

From `evidence-s1b/hosts-erus.txt` (erus Home, one frame): the X99 host, `pub.dev` (32 requests: `pub get` runs in the browser and downloads package metadata), and `fonts.gstatic.com` (1 request, `/s/roboto`: Flutter's fallback font). With `rive`: also 9 `pub.dev` archive downloads and `cdn.jsdelivr.net`. So the viewer needs internet access to `pub.dev` for any package beyond what is in the SDK, and the wasm of `rive`. `worker.js` contains a `pubHostedUrl` field. I did not test whether it redirects `pub get` to a mirror on X99. S2 decision: mirror pub packages and the rive wasm on X99, or accept public fetches.

## Cheese gate reply (2026-11-19 14:19 ICT, decision card)

Chose "đạt". Note: "build quá chậm. Có thể làm near realtime như html được không?" with the page log from the device that opened the link (browser and device not stated):

```
24267 ms worker session
25511 ms pub get 576 ms
41227 ms sandbox connected 1
44762 ms run 1 3534 ms
```

So the loop works on at least one real device, but the first frame took about 45 s there against 9 to 11 s on X99. Reading of the log against the X99 runs:

| Phase | Cheese's device | X99 headless Chrome (3 cold runs, load about 10) |
| --- | ---: | ---: |
| worker session (fetch `worker.js` and `worker.wasm`, start) | 24.3 s | 1.3 to 2.5 s |
| pub get | 0.6 s | 0.6 to 1.0 s |
| sandbox connected (fetch and parse `flutter_web.js`, `dart_sdk.js`) | 15.7 s after pub get | about 9 s |
| compile of the app (`run 1`) | 3.5 s | 3.8 to 5.8 s |

The compile itself is the same on both. The extra 30 s sits in the two download-and-start phases, which fetch about 13 MB. `tailscale status` and `tailscale ping` from X99 at 14:30 ICT: the MacBook (`macbook-pro`) is reached through DERP relay Singapore (about 100 ms), "direct connection not established". That fits a transfer-bound start. I did not measure the MacBook's throughput, so this is a likely cause, not a proven one.

Near realtime, honest status: after the first load, an edit shows in 0.38 to 1.07 s (p50 658 ms), not HTML-instant. The floor seen is about 0.35 s, and it is the compile in the worker. Cold start is the part that can change a lot. Options for S2, none built here:

1. Reload the page on the same device: the 13 MB should come from the HTTP cache (`max-age=86400`), so the second open should skip most of the 24 s plus 16 s. Not yet measured on Cheese's device.
2. Start the worker and fetch the framework when the doop canvas opens, before the first Flutter frame is needed, so the wait is hidden.
3. Serve the assets over a direct path or from a host near the viewer. That is a deploy or public-host decision and stays with Cheese.
4. Hot reload only (no worker restart) already keeps edits near 0.4 to 0.7 s; the debounce is 20 ms and is not the cost.

## Caveats

- Headless Chrome on Linux, not a real viewer's machine. Timings come from a busy X99 (load 9 to 52).
- One `.riv` file, one font, one semantics node.
- Steps 5 and 6 numbers are small samples (5 edits per frame count, one RSS sample).
- The page was written in plain JS, so no product Dart is compiled on X99. The probe apps and `app/lib` are Dart compiled in the browser.

## Commands

```
cd spikes/flutter-lane/s1b
bun serve.ts 19461                                   # tailnet only; env SDK_DIR, SRC_DIR, BLOB_DIR, TLS_DIR
node check.mjs load  https://congvc-x99.taila6fa8a.ts.net:19461/ warm
node check.mjs edit  https://congvc-x99.taila6fa8a.ts.net:19461/ ../app/lib/main.dart 20
node multi.mjs ...                                   # see header of the file
node wire.mjs ...                                    # wire bytes cold/warm
node probe.mjs <url> <font|sem|riv> [png]            # via ./run-probe.sh <kind> [png]
node hosts.mjs <url> <doop:flutter-* type>
node typeedit.mjs "https://congvc-x99.taila6fa8a.ts.net:19461/?edit=1"
```

Served for the Cheese gate by user unit `che7478-s1b` (`systemctl --user stop che7478-s1b` stops it; it stops itself after 72 hours, `RuntimeMaxSec=259200`).

## Disk

`df -B1 /mnt/ssd2` before (task start): used 366,553,661,440, available 110,746,513,408. At 13:45 ICT, with the SDK still on disk for the gate: used 368,029,822,976, available 109,270,351,872. Task-made scratch in `/mnt/ssd2/scratch/che-7478/`: `sdk` 388 MB (served), `zcache` 149 MB, `pub-cache` 64 MB, `profile` 55 MB, `riv-pkg` 14 MB, `dp` 2.4 MB, `blob` 0.5 MB. After the gate reply: remove the whole folder and the unit. (Final `df` line is added in the issue comment when that is done.)
