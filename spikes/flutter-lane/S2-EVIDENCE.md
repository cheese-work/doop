# S2 evidence: a live Flutter screen inside a Rive iPhone shell on Flutter web (CHE-7353)

Spike only. Evidence PR, draft, never merged. Stacked on S1b (CHE-7478, head `b7b39b31`).
Run on X99, 2026-11-19, 18:56 to 20:46 ICT (about 1 h 50 min of the 4 h budget). Browser: Google Chrome 158.0.8127.36 headless (Playwright, `chromium-1254`). Toolchain as in S1b: `package:dartpad` 0.1.4, Dart 3.14.0, Flutter 3.50.0. `rive` 0.14.11 (`rive_native` 0.1.11). Nothing was compiled on X99 or C00: the Dart compiles in the viewer's browser.

Review gates: the project description has no "Review gates:" line, so no gate sub-issues were created.

## Verdict

| Step         | Result                                                                                                                                                                                                                                                   |
| ------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1 shell file | Found and qualifies. Rive community file 19099, artboard `Bezel_BlackTitanium`. Below and above layers made by patching two property sets in the `.riv` (section 1).                                                                                     |
| 2 catalog    | Done: `devices.yml`, every value with its source. Only the pixel size and ppi are Apple-published. Island, corner radius, safe area and scale are measured or third-party (flagged `apple: false`).                                                      |
| 3 harness    | Done. `doop_harness` owns the only `MaterialApp`; a test enforces it (red then green).                                                                                                                                                                   |
| 4 slot       | Works. Slot follows the Rive node through `Artboard.component('doop-screen').worldTransform`, re-read each layout. 12 of 12 geometry checks pass. Texture variant NOT tried (section 4).                                                                 |
| 5 record     | `rive` 0.14.11, renderer `canvaskit`. With `Factory.flutter`: no platform view, no separate canvas, one Flutter scene. With `Factory.rive`: 2 platform views (one canvas each).                                                                          |
| 6 drift      | Position: **0.0 px translation** across 241 of 241 frames with the Flutter factory (lockstep, DPR 2). 60 Hz **not demonstrated**: headless Chrome on X99 renders this scene at 7.5 fps (software GL) or 13.3 fps (RTX 3060). MacBook run is the handoff. |
| 7 input      | Mouse click on Add (twice) and typed text (ASCII, then `đồng`) work with the device scaled to 0.9. 7 of 7 pass.                                                                                                                                          |
| 8 annotation | Done except the Dart Tooling Daemon click-to-source (section 8). Identifier to `{id, rect}` to pin works: pin within 0.40 pt of the painted button, at rest and after a scroll. Semantics on costs about 13 % of the frame rate here.                    |

No stop rule fired: the artboards composite in Flutter's scene on web, and a qualifying shell exists.

## 1. Shell file

- File: "iPhone 16 / iOS 18 Home Screen", author `bryanfunk`, Rive community file 19099 (`https://public.rive.app/community/runtime-files/19099-35931-iphone-16-ios-18-home-screen.riv`). Licence CC BY 4.0. Attribution: this section.
- 1,929,349 bytes, SHA-256 `cc73908b…d90945`. **Not committed.** It is downloaded to a path outside the repo.
- Artboard `Bezel_BlackTitanium` 450 x 920 pt. Nested screen artboard 402 x 874 pt at (24, 23). Corner radius 63 (Rectangle inside the shape).
- It has no animations and a single bezel raster in one artboard, so the below and above layers are not separate artboards. `s2/tools/make-shell.mjs` splits it: it reads the `.riv` v7 binary (property table `riv-key-types.json`, built from the MIT rive-runtime generated headers), and writes two patched copies:
  - `shell-below.riv`: bezel raster hidden, the screen-sized backing switched on and black. Drawn under the screen.
  - `shell-above.riv`: body hidden, only the bezel raster drawn. Drawn over the screen.
  - In both, the nested screen artboard is hidden (opacity 0) and renamed `doop-screen`, so Flutter can ask the runtime for it.
  - Only the objects it patches are rewritten; every other byte is copied.
- Command: `node s2/tools/make-shell.mjs <19099.riv> $BLOB_DIR` → `shell-below.riv`, `shell-above.riv`, `shell.json` (artboard, screen node, radius, source sha256).
- Risk: the split depends on the object layout of this one file (image + shape + nested artboard); the tool throws if the layout differs.

## 2. Catalog

`spikes/flutter-lane/devices.yml`: one entry, iPhone 16 Pro. Each value has `source` and `apple: true|false`. Not Apple-published and flagged so: scale (derived), corner radius 63, Dynamic Island (124.5 x 35.8 at top 14.5, measured on the rendered shell), safe area 62 top and 34 bottom (third-party). The brief asked for Apple's published values: Apple does not publish the island size, radius or safe-area insets, so those are measured or third-party. Step 1's "island matches within 1 pt" was checked against the measured value, not against an Apple number. S3 should check them on a real device. SF Pro is not committed or uploaded; the spike runs on the Flutter default font.

## 3. Harness

- `s2/lib/doop_harness/harness.dart`: `runDoop(product)` and `DoopHarness`, the only `MaterialApp`. It sets the iOS platform (`ThemeData.platform` plus a `ScrollBehavior` whose `getPlatform` returns iOS; no `debugDefaultTargetPlatformOverride`), `Locale('en','US')`, and a `MediaQuery` for the slot (size 402 x 874, padding and viewPadding 62 top and 34 bottom, no view insets).
- `s2/lib/erus_home/`: the product. `product.dart` exports theme, delegates, locales and `onGenerateRoute`; it has no `MaterialApp`. `home.dart` is the erus Home from the S1 app, with a `TextField` (key `note`) added for step 7. It differs from the S1 Home by that field and three `Semantics(identifier:)` wrappers.
- `s2/test/boundary.check.mjs`, 4 tests: product has no `MaterialApp`/`CupertinoApp`/`WidgetsApp`; product does not import the harness; the harness has exactly one `MaterialApp`; `main.dart` builds no app itself. Red (an injected `MaterialApp` in the product): `evidence/boundary-red.txt`, 3 of 4 pass. Green: `evidence/boundary-green.txt`, 4 of 4.
- Known gap: the Navigator sits inside the slot, so a dialog pushed on the root navigator would escape the clip. Not exercised.

## 4. Slot

How it works: `Artboard.component('doop-screen')` gives a `Component`; `worldTransform` (a `Mat2D`, values 4 and 5 are tx and ty) gives the node position in artboard units. The harness maps it through the same `contain` fit the two Rive widgets use and puts the product in `Positioned.fromRect(slot)` → `FittedBox(fill)` → `ClipRRect(radius 63)`. Order in the Stack: below layer, product, above layer. It is recomputed at every layout.

One trap: `worldTransform` reads as identity until Rive has drawn one frame. The first layout put the slot at (35, 10) instead of (59, 33). The harness now rebuilds once after the first frame and only then reports `doop:flutter-ready`.

Test first (`s2/check.mjs`, 12 checks): slot reported, slot came from the Rive node, slot origin and size equal artboard centre + screen node, a 4 pt magenta probe ring is visible on all four sides, each ring edge sits on the bezel cutout edge within 1 device px, ring centred. Red against a harness with no slot (`evidence/red-slot.txt`, 0 of 4): the page reports `harness: none`. Green (`evidence/green-slot.txt`): 12 of 12. Screenshot: `evidence/slot-green.png`.

The texture variant (texture during motion, live widget at rest) was not tried. Reason: the 4 h budget went to the drift work and to the finding in section 6 that the texture-based Rive factory is unstable on web. It is a follow-up.

## 5. `rive` and the layer tree

- `rive` 0.14.11, `rive_native` 0.1.11, renderer `canvaskit` (not skwasm). Two factories exist: `Factory.flutter` draws the Rive artboard through Flutter's own canvas; `Factory.rive` draws through Rive's own renderer into its own WebGL context.
- `s2/dom-probe.mjs` output (`evidence/dom-flutter.txt`, `evidence/dom-rive.txt`):
  - `Factory.flutter`: 0 `flt-platform-view` elements and no canvas outside Flutter's own view (Flutter's canvas sits in its shadow root, which this probe does not enter). Below layer, product and above layer are in one Flutter scene. This meets "no separate canvas or platform view between the artboards".
  - `Factory.rive`: 2 `flt-platform-view` elements, each holding a 900 x 1840 canvas (one per layer). A platform view sits in the DOM between the layers, and the product's pixels cannot be composited between them in the same way. Not the shape the brief wants.
- WebGL renderer in these runs: ANGLE on the NVIDIA RTX 3060 (Vulkan) with the flags in section 6.

## 6. Drift at 60 Hz

Method (`s2/drift.mjs`; run `s2/run.sh drift.mjs`, which serves on the tailnet only):

- The harness animates the device box (`anim=drift`): scale breathes between 0.78 and 1.0 over 240 frames, so the slot moves and resizes every frame. A 4 pt magenta ring sits at the slot edge, and a 16-cell strip in the page corner shows the frame number.
- For each captured frame the script reads the frame number from the strip, then measures the ring edges along the middle row and column. The harness logs the slot rectangle it computed for every frame. Report per frame: edge positions vs the cutout (from the manifest), translation (mean of opposite edge deltas) and thickness.
- Translation is the drift. Size and thickness are limited by the colour threshold (about 0.64 px per edge), so they are reported separately and not as drift.
- Modes: `MODE=step` (lockstep: the page advances one frame on a message and a lossless screenshot is taken at DPR 2; exact, not real time), `MODE=screencast` (live, Chrome CDP screencast frames), `MODE=rate` (no capture; only the Flutter frame rate). `SEM=1` turns Semantics on in `rate` mode.
- The script runs on any Chrome with Playwright. S3 reuses it on the MacBook (`DPR`, `FRAMES`, `CHROME_ARGS` are env vars). Screencast frames are CSS-pixel sized whatever the DPR, so the script reports the effective DPR it measured at.

Results (`evidence/drift-summary.txt`, per-frame JSON in `evidence/drift-*.json`), GPU Chrome unless noted:

| Factory | Mode        | Frames matched | Translation (px)             | Max edge delta | Max thickness delta | Offenders (\|trans\| > 0.5 or \|thick\| > 1.5) |
| ------- | ----------- | -------------: | ---------------------------- | -------------: | ------------------: | ---------------------------------------------: |
| flutter | step, DPR 2 |     241 of 241 | 0.0 on 480 values, -0.5 on 2 |           0.90 |                1.35 |                                              0 |
| flutter | screencast  |     241 of 241 | 0.0 on all 482               |           0.81 |                1.32 |                                              0 |
| rive    | step, DPR 2 |     196 of 241 | 0.0 on 278, ±0.5 on 114      |           1.57 |                2.00 |                                             61 |
| rive    | screencast  |     195 of 240 | 0.0 on 345, ±0.5 on 45       |           1.02 |                1.51 |                                             27 |

Slot rectangle the harness logged vs the one derived from the manifest: max 1.7e-13 CSS px, every frame, both factories. So the layout code does not drift. The pixel measurements agree to the quantisation of the colour threshold.

What this means, in order of weight:

1. **Position holds with the Flutter factory.** No non-zero translation beyond one half device pixel on 2 of 482 values, over 241 frames of a scale change that moves every edge of the slot.
2. **60 Hz is not shown.** Flutter frame rate in headless Chrome on X99, 240 frames of this scene: 7.5 fps on the default software GL (SwiftShader), 13.3 fps with ANGLE/Vulkan on the RTX 3060 (`--use-gl=angle --use-angle=vulkan --enable-features=Vulkan --ignore-gpu-blocklist --enable-gpu-rasterization`), 6.4 fps with `Factory.rive`. The screencast capture ran at 11.6 fps while the animation ran at 11.7 fps. "No drift" is shown per frame, not at 60 frames a second. A drift that depends on frame timing at 60 Hz is not excluded by this data. The MacBook run (S3) is the check; no X99 setting I tried reached 60 fps (`angleGL` and `egl` gave no WebGL 2).
3. **`Factory.rive` is unstable on web.** In lockstep, the WebGL context was lost after about frame 196 of 241: the iframe shows the browser's crash icon (`evidence/drift-step-rive-190.png` is fine, `-200.png` is the crash). The 45 frames after that have no ring. Before that, edges differ by up to 1.57 px. Not root-caused. It also puts two platform views between the layers (section 5), so it fails the "no platform view" condition regardless.
4. The scale change also changes the size of the Flutter surface each frame; the Flutter factory still held. Not tested: window resize, device pixel ratio change, and a Retina (DPR 2) screen with a real display refresh, which is what S3 does.

## 7. Input

`s2/input.mjs`, device scaled to 0.9 (`&scale=0.9`, a harness flag added for this test). Real mouse and keyboard events through Playwright:

- The Add button's position comes from the Semantics tree (`flt-semantics-identifier="erus-add"`), in the iframe's coordinates. Two clicks reach the button: the bridge posts `doop:flutter-tap` with `taps` 1 then 2.
- A click on the Note field focuses the engine's hidden `<input>`; `keyboard.type('hello 123')` then `insertText(' đồng')`: the harness receives `doop:flutter-text` with value `hello 123 đồng`.
- Red first (`evidence/input-red.txt`, 3 of 6): the harness ignored the `scale` flag, so the slot width was 402, not 361.8. Green (`evidence/input-green.txt`): 7 of 7. A click is correct at the scaled position, so the pointer path through `FittedBox` is right.
- Not tested: touch, IME composition, a long press, text selection handles, the soft keyboard on iOS. Those need real devices (S3).

## 8. Node annotation probe

What was done (`s2/pins.mjs`, `lib/doop_harness/harness.dart` `_postNodes`):

- Three Home widgets carry `Semantics(identifier: …)`: `erus-net-worth`, `erus-add`, `erus-recent`. (The brief names them `home.<name>`; the identifiers here use `erus-*`. A rename is one line each.)
- Flutter web builds the Semantics tree only when asked. The harness clicks the engine's `flt-semantics-placeholder`; every identifier then appears as a `flt-semantics-identifier` attribute on an `flt-semantics` element (`evidence/pins-green.txt`: all three present).
- On a `doop:nodes` message, the harness answers `doop:flutter-nodes` with `{nodes:[{id, rect}], k, slot, ms}`. `rect` is in product points (the 402 x 874 screen space) and is computed as `(DOM rect − slot origin) / k`. So the message does not change when the device box is scaled or moved; the receiver maps it back with `page = iframe origin + slot origin + k · rect`.
- Pin test (red then green; `evidence/pins-red.txt`: no `doop:flutter-nodes` reply, 0 of 1; `evidence/pins-green.txt`: 4 of 4). The outer page draws a pin at the mapped rect. The check measures the **painted pixels** of the Add button independently (bounding box of the pixels near the button's own colour, sampled from the screenshot) and compares the four edges to the pin. At rest, device scaled to 0.9: max edge delta **0.40 pt**. After a mouse-wheel scroll that moved the button by 30 pt: **0.40 pt**. Both are inside the 1 pt limit; 0.4 pt is the half-pixel quantisation at DPR 2. Screenshots with the pin drawn: `evidence/pin-rest.png`, `evidence/pin-scrolled.png`.
- Net worth and Recent were not compared to painted pixels: the `Card` margin (4 pt) is inside the Semantics rect, so their painted box is inset by it. Only the Add button, which has no margin, is checked.
- Cost of a `doop:nodes` answer: median and max 0.2 ms over 20 calls (3 nodes). The timer resolution here is 0.1 ms, so read it as "under 0.3 ms".
- Cost of turning Semantics on, as frame rate in `MODE=rate` (240 frames, same scene, GPU Chrome, alternating runs): off 13.4 and 12.7 fps, on 11.7 and 10.9 fps. About 13 % lower, about 10 ms more per frame at this frame rate. Measured on a slow renderer; the ratio on a fast one is unknown.
- **Dart Tooling Daemon (click → widget and file:line): not done.** What I observed (`evidence/dtd-probe.txt`): the sandbox window has `$dwdsVersion` and `dartDevEmbedder` (DDC debug hooks), but no VM-service endpoint is exposed, and the page runs at `about://` inside a `srcdoc` iframe. DTD and the widget inspector need a debug service (`flutter run` or `dwds`) that a toolchain process serves; this spike compiles only in the viewer's browser and nothing compiles on X99. I did not try to attach one. Whether the DDC hooks can reach the inspector extension from the player page is an open question for a follow-up.

## Caveats and open items

1. 60 Hz is unproven (section 6). The drift script is MacBook-ready; that run and S3's 120 Hz run are the real test.
2. `Factory.rive` is unusable here (context loss, platform views). The result holds for `Factory.flutter` only.
3. Step 8's click-to-source part (DTD) is not done; the texture variant of step 4 is not done.
4. The shell split patches one third-party file's binary; it is licensed CC BY 4.0 (attribution above) and is never committed.
5. Island, corner radius, safe area, scale are not Apple-published values (`devices.yml`). SF Pro not used.
6. The Home differs from the S1 app: a `TextField` and three `Semantics` wrappers.
7. A root-navigator dialog escapes the slot clip. Not exercised.
8. X99 is shared; frame rates varied by about 10 % between adjacent runs.

## Files

`spikes/flutter-lane/devices.yml`; `s2/lib/` (harness, product); `s2/tools/make-shell.mjs`, `riv-key-types.json`; `s2/check.mjs`, `input.mjs`, `pins.mjs`, `drift.mjs`, `measure.mjs`, `dom-probe.mjs`, `dtd-probe.mjs`, `summarize.mjs`, `run.sh`; `s2/test/boundary.check.mjs`; `s2/evidence/`. Changed from S1b: `s1b/serve.ts` (recursive folder read and watch, so `lib/` subfolders work) and `s1b/page/page.js` (iframe size from `?w=` and `?h=`).

Run: `BLOB_DIR=<dir from make-shell.mjs> s2/run.sh check.mjs` (also `input.mjs`, `pins.mjs`, `drift.mjs`).
