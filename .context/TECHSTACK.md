# TECHSTACK - doop

## 1. Language and Runtime

- TypeScript 5.9 (strict mode) - primary language across `server/`, `src/`, and `shared/`.
  `bun run typecheck` uses `tsgo` (`@typescript/native-preview`, the TypeScript 7 Go compiler) for
  speed; the JS `typescript` package serves editors and the ESLint parser.
- Node.js - runtime; `tsx` 4.23.9 runs server TypeScript directly with no build step, both in dev
  (`tsx watch`) and prod (`NODE_ENV=production tsx server/index.ts`).
- Bun 1.3.10 - pinned via `packageManager` in `package.json`; used as the package manager and
  script runner, not as the server runtime.
- Rust (stable) - `desktop/src-tauri`, the Tauri desktop shell.

## 2. Core Frameworks and Libraries

- Express 4.19.2 - HTTP server framework in `server/`.
- React 18.3.1 - UI framework in `src/`.
- Zustand 4.5.4 - client-side state management.
- Element links use `/c/<canvasId>?frame=<frameId>&selector=<encoded CSS selector>`.
  `src/lib/elementLink.ts` owns copying from the element toolbar and Layers menu;
  `Stage.tsx` focuses its page and frame; `FrameView.tsx` resolves the selector in
  the ready iframe, including script-created elements, and falls back to frame
  details if it no longer resolves. Browser regressions in
  `tests/pageCanvasBrowser.test.ts` cover initial loading, cross-page links,
  clipboard round trips, history and script-created or script-removed elements.
- Radix UI primitives (`@radix-ui/react-*`, ^1.x-2.x) + shadcn 4.19.0 - accessible UI primitives
  generated into `src/components/ui`.
- `@anthropic-ai/sdk` 0.115.0 and `@modelcontextprotocol/sdk` 1.12.0 - power the built-in Doop
  Agent and the MCP server that lets external agents (e.g. Claude Code) design on a canvas.
- Claude Code on the desktop (`shared/localAgent.ts`, `server/localAgent.ts`,
  `desktop/src-tauri/src/claude.rs`): the model menu is the CLI's aliases (`CLAUDE_MODEL_ALIASES`),
  which `claude --model` resolves to the newest model the installed CLI knows, plus a pinned
  `claude-*` id accepted by shape (`isClaudeModel`, mirrored by `valid_model` in the shell before the
  value becomes an argument); `effort` (`CLAUDE_EFFORTS`, `local_agent_preferences.effort`) rides the
  job and becomes `--effort`. A pre-alias shell's "Invalid model" is reworded by
  `localAgentRuns` into an update prompt.
- Model menus (`server/modelCatalog.ts`, `GET /api/model-account/models`): the connected
  account's picker asks the provider's catalog with the user's own key when it opens (the
  composer's `ModelPicker`) or mounts (Settings, `useAgentModels`), merging the curated entries of
  `shared/modelMenu.ts` / `shared/localAgent.ts` on top as `recommended`; a provider without a
  loader, or one that cannot be reached, gets the curated menu with `live: false`. Anthropic and
  OpenAI (`/v1/models`), Gemini (`/v1beta/models`) and ChatGPT subscriptions (the Codex backend's
  catalog, `CHATGPT_MODELS_URL`, asked with the account's token as Codex CLI
  `CHATGPT_CODEX_CLIENT_VERSION`; the route refreshes the token first) have loaders, each with a
  family filter for reasoning chat models with tools, images and a 16k output window; a picked id
  only has to be shaped like the provider's, and the run is the final check. OpenRouter stays on
  its curated roster (the run-time vision check knows only the roster's flags).
- Reasoning effort on a user's OpenAI account (ChatGPT subscription or OpenAI key): the pick lives
  in `model_accounts.reasoning_effort` (`REASONING_EFFORTS` in `shared/modelMenu.ts`: low / medium /
  high / xhigh), set through `PATCH /api/model-account { effort }`, read by `effortFor` in
  `server/openaiAgent.ts` for every turn, with `DOOP_AGENT_OPENAI_EFFORT` as the default until a
  user picks. The status reports the resolved `effort` for the OpenAI kinds only, which is what
  shows the `Segmented` switch in Settings and the radio group in the composer's `ModelPicker`.
- `ws` 8.18.0 - WebSocket server for realtime multiplayer (cursors, presence, frame edits,
  activity feed) over one room per canvas.
- `pdf-lib` 1.17.1 - joins the vector PDF export (`server/pdfExport.ts`): headless Chrome prints
  each frame onto a page of its own size, pages in the order the frames are listed (a whole page
  in canvas reading order, `shared/frameOrder.ts`; the Export checklist sends its displayed
  order); render limits in `shared/pdfLimits.ts`, which also sizes the browser's download
  timeout; served by `GET /api/canvases/:id/export.pdf` and MCP `export_frame`.

## 3. Data and Persistence

- PostgreSQL 16 (`postgres:16-alpine` in `docker-compose.yml`) - primary database.
- drizzle-orm 0.45.2 + drizzle-kit - schema in `server/db/schema.ts` and
  `server/db/auth-schema.ts`; migrations generated via `npx drizzle-kit generate` into
  `server/db/migrations`, applied at boot by `server/db/index.ts` (never by drizzle-kit itself).
- `@electric-sql/pglite` 0.5.4 - embedded Postgres so `bun run dev` works with zero external
  services.
- `pg` 8.22.0 - Postgres driver for the real-database path.
- Automations (`shared/automations.ts`, `server/automations.ts`) support schedules and
  approval triggers scoped to one canvas. The five-second worker groups up to ten signed-off
  frames per run. `automation_approvals` retains dispatch receipts independently of the
  pruned run log. Run state stores the approved source identities, frozen steps, current
  step, task ID, summaries and result links; database leases serialize execution. Agent tasks
  and their wait points commit together. The next step waits for completion, checks source
  approvals and access again, and stops on failure or after one hour. Interrupted external
  calls require a destination check rather than automatic replay. Integration-owned action
  hooks create Linear issues or send Slack messages using the workflow owner's connection.
  Approval presets create draft sizes, translations and companion assets on the watched canvas.
  The worker queues independent workflows with concurrency four and keeps discovering work
  while integrations await I/O. Receipt lookup is batched. Later agent briefs include earlier
  draft-result links and completion summaries, so localization can build on generated sizes.

## 4. Canvas Drawing

- Canvas zoom: the camera runs from 8% to 1600% (`MAX_ZOOM`, mirrored by `FOLLOW_MAX_ZOOM`).
  `Stage.tsx` lays the `.world` out at CSS zoom k, the settled camera zoom clamped
  to 1-16, and its transform carries only the camera's movement since (`scale(zoom / k)`).
  Chromium passes k into each frame iframe (and the drag preview) as pixel density, so frame
  documents keep design-px viewports and rasterize at k×, out of process too (a transform on
  the iframe only stretched a 1× raster there); k is the whole number at or above the zoom,
  since the iframe box snaps to whole pixels and only a whole k keeps every design size exact.
  Elsewhere (`FRAME_DOCUMENTS_TAKE_ZOOM_AS_DENSITY` false) each `FrameView` iframe undoes k (`zoom: 1/k`, `scale(k)`); `src/lib/layoutZoom.ts` snaps k to a
  float32 whose inverse multiplies back to exactly 1, since engines multiply zoom in float32.
  WebKit (the desktop app) rasterizes a composited layer at its CSS size, so a transform-only
  scale went soft past 100%. Both engines tile what is on screen, so backing memory follows the
  viewport, not k. From 300% a 1px pixel grid fades in over the frames (full at 500%). Frame
  names live in a screen-space layer (`FrameLabelLayer`), placed from `--vx`/`--vy`/`--zoom`, so
  they keep size, gap and crisp text at every zoom.
- `src/lib/tools.ts` defines bottom-toolbar tools and shortcuts. `Stage.tsx` delegates drawing
  gestures and world-space previews to `CanvasDrawing.tsx`; Space/middle-button panning takes
  precedence over drawing.
- `src/lib/drawing.ts` creates rectangles, circles, straight and cubic Bézier SVG paths, text and empty
  frames through the existing frame API. Drawing inside a frame appends a positioned HTML/SVG
  layer. Standalone elements use frame persistence with a `data-doop-canvas-element` body marker
  for transparent canvas chrome; no separate shape schema or protocol is required.
- The pen snaps to the nearest anchor on its unfinished path within eight screen pixels,
  highlights the target, and previews a closed curve when approaching the first anchor.
  Alt bypasses snapping. Double-clicking a native path opens `PathEditor.tsx`: anchors and
  Bézier handles can be dragged, and points can switch between corners and curves or be deleted.
  Drawing and editing use 0.75px guide strokes, 5px anchor markers and 4px handle markers at every
  zoom. Invisible 18px editing targets keep the smaller markers easy to grab.
  Each completed edit is one undo step. Alt moves a handle independently; Shift constrains
  its angle. `pathEditing.ts` reads existing line/cubic SVGs, preserves their affine transforms,
  resizes standalone bounds, and refuses to overwrite a concurrently changed path. The editor
  overlays the world canvas while the iframe hides the original through a transient marker.
  It refreshes geometry from the latest store state after saves, undo/redo, and remote changes,
  so an undo issued while a save finishes cannot leave stale anchors in the editor.
  Selecting an anchor or handle does not edit it until the pointer moves two screen pixels.
  Path saves send `expectedUpdatedAt` to the frame PATCH route. The server checks it synchronously
  before writing and returns HTTP 409 with the current frame on a conflict; the editor reloads
  that version without recording an undo step. Frame timestamps advance monotonically, even
  for multiple writes in the same millisecond, so concurrent saves cannot share a version.
  Delayed HTTP save responses cannot replace a newer frame received through the room.
- Saves are serialized, tracked by undo/redo, and scoped to the originating canvas/page. Each
  completed gesture has its own undo entry. The Layers panel shows the drawing's `data-name`.
  Completed saves survive navigation; unfinished drafts are cancelled. Drawing shortcuts leave
  native fields and rich-text editors alone, except for the drawing textarea's save/cancel keys.
- `ElementMove.tsx` renders an unclipped drawing preview and highlights the destination frame.
  Ordinary HTML/SVG layers move in place through the runtime's geometry/style gesture bridge,
  preserving layout and transforms and committing one undo step per drag.
  The iframe runtime hit-tests the pointer in browser paint order and measures CSS layout
  size separately from transformed bounds. Pending pointer events are buffered until its
  reply, so fast drags and cancellation remain reliable. `src/lib/drawingMove.ts` preserves markup and translates coordinates when
  moving drawings into, between, and out of frames. Transfers save the destination before
  removing the source and use one undo entry; a failed prerequisite leaves the original intact.
  Rollback keeps a detached copy if its content, name, geometry, page, or flags changed after creation.
- A selected element inside a frame is dressed the way Paper draws a selection: a one-pixel
  outline, a square grip in each corner, grabbable unmarked edges, and a `W × H` badge underneath
  (`ElementResizeHandles.tsx`; geometry in `src/lib/elementResize.ts`). A drag opens the runtime's
  style gesture (`styleGesture` begin / commit / cancel in `frameBridge.ts`), previews inline
  `width` / `height` in the live document on every move and commits once on release as a discrete
  undo step, the same properties the Design panel's Size fields write. Pulling a west or north
  side outward still grows the box (flow layout places the element; the drag changes its size,
  never its place). Deltas are measured from the computed size, so a content-box element keeps
  its padding, divided by the element's render scale, and re-anchored while a pinch owns the
  finger. Shift keeps the aspect ratio (letting go puts the other axis back); Esc, or the grips
  leaving mid-drag, cancels. The runtime's hit info carries `sizable` and `locked`, so inline
  text runs, rotated or skewed elements, locked layers, locked frames and the Comment tool get no
  grips. `tests/elementResize.test.ts` covers the geometry and `tests/elementResizeBrowser.test.ts`
  drags the grips in Chromium.
- Rulers and guides (`src/components/Rulers.tsx`, math in `src/lib/rulers.ts`): ⇧R or the zoom menu
  toggles `<canvas>` rulers docked on the stage's top and left edges (the top bar and the floating
  chrome step in by `RULER_PX`) (remembered under
  `doop:rulers`, hidden on phones and under ⌘.). Ticks step 1/2/5×10ⁿ by zoom; labels count from the
  selected frames' top-left, whose extent is highlighted. Dragging out of a ruler adds a guide;
  guides drag, drop back on their ruler or Delete to remove, and undo/redo (`history.ts` `guide`
  entries). Guides live in `canvases.guides` (jsonb, per page, client-generated ids), written one
  at a time through `PUT`/`DELETE /api/canvases/:id/guides/:guideId` behind `requireCanvas` and
  broadcast as `guide` room messages; page copies and canvas copies take them along (within
  `MAX_GUIDES`), a deleted page drops its guides and page undo/redo puts them back. Writes to
  one guide run in order, and a failed one rolls back only when no newer edit follows. Visible
  guides join `snapFrame` (frame move/resize, element moves), element resize and drawing points
  at the same 8-screen-px tolerance; Alt bypasses. Tests: `rulers.test.ts`, `snapGuides.test.ts`,
  `guides.test.ts`, `guideEdits.test.ts`, `rulersBrowser.test.ts`.
- `tests/drawing.test.ts` covers geometry, serialization and persistence; `drawingBrowser.test.ts`
  exercises the toolbar and gestures in Chromium, including Bézier paths, frame transfers,
  cancellation, mobile input, and coexistence with canvas comment pins and reply fields.
  `tests/drawingMove.test.ts` covers transfer persistence, locks, failed saves and rollbacks,
  creation queued with transfers, and undo/redo. Browser regressions cover transformed shapes,
  stacking contexts, covered shapes, and delayed hit-test replies.

## 5. Security and Secrets

- Prototypes (`.context/specs/prototyping.md`): interactions are `data-doop-on` /
  `data-doop-action` (or the JSON `data-doop-interactions`) attributes in frame HTML, parsed by
  `shared/prototype.ts`, whose parser the frame runtime inlines by source. `PrototypePlayer.tsx`
  (Play, and the full-page `/c/<id>/proto`) runs them with Web Animations transitions; the
  Prototype tab and `PrototypeOverlay.tsx` edit and draw them; MCP has `get_prototype` and
  `set_prototype_start`. `tests/prototypeBrowser.test.ts` drives the player in Chromium.

- Design completeness (G3, CHE-6078): MCP `check_design_completeness` runs `shared/designCompleteness.ts`
  over one page (recon inventory `doop-recon` with `data-recon-ref` per Keep/Change item, wireframe,
  states, `data-doop-motion` blocks, prototype wiring and reachability; ruleset `g3-r6` (CHE-6853) adds a motion block
  per transition, the `Motion` page with the issue's `<KEY> · motion` spec frame whose rows each name an animated frame,
  and a `<screen> · doc` frame with the 7 filled headings per hi-fi screen; `g3-r7` (CHE-6854) adds a Hallmark `sloplint`
  result per design frame at its `updatedAt` (the reviewer's JSON with its SHA256, checked in `server/sloplintInput.ts`),
  the `Components` page (tokens frame, components, `component_unknown`, variants and states, motion per micro-interaction)) and stores the result in
  `design_attestations`, one row per design frame at its `updatedAt`, append-only. The route
  `/api/design-attestations/:id` reads a run with `current` (false once any frame changed).
  `GET /api/service/design-attestations/:id` (G4, CHE-7080) serves the same JSON plus `pageIssueId` (the attested
  page's current Multica issue, or null) to Multica: it sits before the `/api` session gate, wants
  `Authorization: Bearer <DOOP_ATTESTATION_READ_TOKEN>` (compared as SHA-256 digests with `timingSafeEqual`; 401 if
  missing or wrong, 503 while the variable is unset, at least 32 characters), is GET only, and 404s an unknown id.
  `extraChecks` is the plug-in point for the requirement ledger. Tests: `designCompleteness.test.ts`,
  `designAttestation.test.ts`.

- Recon guard (G2, CHE-6627, `server/reconGuard.ts`, `server/reconScan.ts`): `assertWritable` refuses an agent's
  `create_frame` on a page bound to an issue (only a frame that is nothing but the `doop-recon` script, `isReconOnly`, is exempt; design markup beside it is gated) until the
  page has one recon frame whose scan-derived matrix (screen x state x device 1440/390) has a real image per cell
  (uploaded, non-empty, PNG width = device, no image reused; `n/a` only with scan proof), every scan candidate has a
  decision, the issue holds this agent's earlier comment with `recon-manifest: sha256=` of the recon JSON, `main-sha:`,
  `recon-images:` and the frame id, and the frame is locked. Images and comments reach the synchronous store through a
  cache `warmReconEvidence` fills (MCP `create_frame` calls it); `setReconSources` plugs them in and, with no
  comment source, every such write is refused. Production wires `httpCommentsSource` (`server/multicaRuns.ts`, `GET /api/issues/:id/comments`, agent-authored comments only, Multica's own author and time) at boot when the four `MULTICA_*` settings exist. `scripts/recon-scan.ts` prints the scan; it is a read-only heuristic
  (relative imports, line regexes), a floor and not proof of completeness. Tests: `reconScan.test.ts`, `reconGuard.test.ts`.

- better-auth 1.6.26 - authentication: email/password, generic OIDC/SSO, and Google / Microsoft /
  Apple sign-in (social providers, `GOOGLE_*` / `MICROSOFT_*` / `APPLE_*` client pairs; the iOS app
  signs in with Apple natively against `APPLE_APP_BUNDLE_IDENTIFIER`). Configuration and secrets
  (`BETTER_AUTH_SECRET`, `BETTER_AUTH_URL`, provider client IDs/secrets) come from the
  environment (`.env`, documented in `.env.example`); never committed.

- Multica links (`shared/pageIssue.ts`, `server/multicaRuns.ts`): a page's `issueId` is server-owned like
  `startFrameId` (`setPages` and copies drop client values) and is written only by a member's
  `PUT /api/canvases/:id/pages/:pageId/issue` or the Design-property derivation (`store.applyDesignLinks`,
  fail closed on a missing or conflicting link); MCP has no tool for it. An MCP call's `X-Multica-Task-Id` header
  is stored on the agent task (`tasks.multica_task_id`). `GET /api/canvases/:id/pages/:pageId/runs` lists the
  bound issue's runs from Multica (`MULTICA_API_URL`, `MULTICA_API_TOKEN`, `MULTICA_WORKSPACE_ID`,
  `MULTICA_WEB_URL`; 503 when unset), each with a hop-in URL.

- Write policy (`server/writePolicy.ts`, CHE-6624): every `store` mutator (`createFrame`, `updateFrame`,
  `deleteFrame`, `deleteCanvas`, `setPages`, `duplicatePage`, `bindProject`) takes a required `WriteContext`
  first and calls `assertWritable` in the same synchronous tick as the change; a refusal throws
  `PolicyRefused` (`policy_refused`), distinct from the `undefined` of "not found". A canvas carries a
  server-owned `projectId` (`canvases.project_id`). An agent with an `X-Multica-Task-Id` writes only when
  Multica vouched for the task (`setTaskIdentityVerifier` + `warmTaskIdentity`, cached 5 min; the header alone
  is never trusted; with `DOOP_MULTICA_ASSERTION_KEYS`, `MULTICA_API_URL` and `MULTICA_API_TOKEN` set, `server/taskAssertion.ts` plugs the verifier in from Multica's signed `X-Multica-Task-Assertion` (Ed25519 `mta1.` token, D1.6 of CHE-7064; the claims give task, agent, issue, project, provider and model; liveness from `GET /api/issues/{iid}/task-runs`; the bare `X-Multica-Task-Id` then never verifies)), the canvas is bound to the task's project and the page to its issue. With no verifier
  plugged in every such write is refused. An agent with no task may write to unbound canvases only, and once a verifier is plugged in an MCP agent
  without a task is refused everywhere; a design-sync (ingest) key is held to the binding like an agent; no agent binds
  or deletes a canvas. A page copy re-checks the policy inside its database transaction, so one that loses a race rolls back whole; `bind_project` is refused while a copy is in flight. Past the lock rules below, users and the system pass.
  Frame lock (G5a, CHE-6626): a `locked` frame refuses every write from every actor, the system included
  (`assertWritable`, `lock_frame`/`unlock_frame` ops); a canvas holding one cannot be deleted (account erasure,
  `erasureContext()`, is the exception) and `set_pages` cannot drop its page; copies start unlocked. `store.lockIfVersion`
  (MCP `lock_frame_if_version`, `actions.lockFramesForPublish`) is a compare-and-set against the attested `updatedAt`
  and does not move it, so the G3 attestation stays current; the frame carries `lockEpoch` (up on every unlock, never
  reused) and `lockAttestationId` (`frames.lock_epoch`, `frames.lock_attestation_id`, migration 0042). Unlock is
  `{ locked: false }` alone, from a signed-in user whose account id is in `setLockOwners` (an agent never unlocks; no
  owners set = nobody unlocks; `server/index.ts` fills it at boot from `DOOP_LOCK_OWNERS`, a comma list of account ids).
  `lockIfVersion` on an already locked frame never rewrites the attestation: the same id is a no-op (`already`, no
  write, no broadcast), another id is `policy_refused` until an owner unlocks. It raises `lockEpoch`, drops the attestation id and moves `updatedAt`, so the old
  attestation no longer matches. `expected_updated_at` fences MCP `set_frame_html`, `edit_frame_html`,
  `append_frame_html` and `update_frame` (`VersionChanged`, `version_changed`). REST answers a refusal 423 and a lost
  fence 409. `tests/frameLockPolicy.test.ts` covers it. `tests/writePolicy.test.ts` also scans `server/` so a new
  writer outside `store.ts` and `db/persist.ts` fails CI.

- Lock pins (G5b, CHE-7062, `server/framePins.ts`, `server/pinState.ts`, table `frame_pins` + `frame_pin_frames`,
  migration 0043): a decision card holds the frames it shows. States RESERVED -> HELD -> SEALED -> RELEASED; no clock
  moves a pin. Steps: `reserveLock` (P4, all or none, idempotent on `cardRequestId`), `confirmPin` (P6, receipt R1),
  `pinForPick` (K2, one transaction HELD -> SEALED, receipt R2), `releasePin` (K5/C2: doop asks Multica itself through
  `MulticaPort` and releases only on `decided` or `void`), `forceRelease` (F1: a lock owner; `abort_ref` first; a `void`
  raises `lockEpoch`). Receipts are HMAC-SHA256 over card, pin, state, epochs (+ pick) with `DOOP_PIN_SECRET`; unset =
  no receipt. `store.unlockFrame` (async) answers `pinned` while a pin exists and writes the row before memory changes;
  the synchronous unlock in `updateFrame` refuses a pinned frame too. `store.lockIfVersionDurable` (MCP
  `lock_frame_if_version`) answers only after its row is written and reverts memory if that write fails. Pins are read
  back at boot (`loadPins`). Not wired yet: the Multica port itself (A1 `ref_status`/`abort_ref`, A2 `abort_if_pending`)
  and an HTTP/MCP route for P4/P6/K2/K5/F1. Tests: `framePins.test.ts` (temporary pglite).
  Pin reconcile (G5c, CHE-7063, `server/pinReconcile.ts`): `startPinReconcile` (30 s, started at boot) calls
  `reconcilePins`, which asks Multica about every pin older than `T_RECONCILE_MS` (120 s since its last state change)
  and never releases by time (B4). `pending` or missing -> A2 `abortIfPending` (a conditional CAS: a card that is
  already `open` is left as it is, with its HELD pin); `decided` / `void` -> `releasePin`; `open` / `pick_pending` ->
  nothing; Multica silent -> the pin is listed by `stuckPins()` with its age (the "ghim treo" warning), never released.
  `MulticaPort.abortRef` (A1, unconditional) stays for `forceRelease` only. Tests: `pinInterleave.test.ts` (the 12 x 5
  table, `pin/G1..V2/E1..E5`), `pinConcurrent.test.ts`, harness `tests/support/pinHarness.ts` (`pauseAfter`, fake clock,
  `crashMultica`/`restartMultica`, `dropResponse`, `assertInvariants` over both databases).

## 6. Build and Dependency Management

- Canvas access: `canvasRole` in `server/access.ts` gives owners, members and workspace members
  edit, and share-link visitors the link's level (`none` / `view` / `comment` / `edit`). REST,
  the WebSocket room and MCP gate reads, comments and writes on it separately; spec in
  `.context/specs/share-link-roles.md`.

- Bun 1.3.10 - package manager; lockfile at `bun.lock`, installed with `bun install
--frozen-lockfile` in CI.
- Vite 8 (Rolldown-based) - frontend build tool (`vite build`), with `@vitejs/plugin-react` 6.

## 7. Testing Stack

- Vitest 5 - unit/integration tests across `server/` and `src/`; run via `bun run test`
  (`vitest run`). Tests live in `tests/`.

## 8. CI/CD and Delivery

- GitHub Actions:
  - `.github/workflows/ci.yml` - gates `typecheck`, `lint` + `format:check` + `doc-lint`, `build`
    and `test` (four vitest shards) as parallel jobs on push to `main` and on PRs, cancelling
    superseded PR runs; a separate job lints the PR title with commitlint (PRs land on
    `main` as a squash, so the PR title becomes the commit subject).
  - `.github/workflows/cla.yml` - CLA check (this is an AGPL-3.0 project with CLA-based
    contribution).
  - `.github/workflows/desktop.yml` / `desktop-release.yml` - Tauri desktop app CI and DMG
    release (tag `desktop-v*`, universal macOS build, optional Apple signing/notarization).

## 9. Infrastructure and Deployment

- Experimental Gemini cloud pilot: `server/geminiCloudRuns.ts` dispatches resident harness tasks
  to per-user workers; `server/geminiCloudMcp.ts` exposes run-scoped canvas tools. The standalone
  worker runs official Gemini CLI headlessly, with Google credentials retained in its own volume.
  `workers/gemini/Dockerfile` builds the worker. Setup and limitations: `docs/gemini-cloud-pilot.md`.
  `DOOP_GEMINI_CLOUD_WORKERS` enables operator-managed routing and BYO metering; unset by default.

- Docker - `Dockerfile` + `docker-compose.yml`; `docker compose up` runs the app container
  (port 4400) and a `postgres:16-alpine` db container for self-hosting.

## 10. Frontend Stack

- React 18.3.1 + Vite 8 - SPA, entry at `index.html`.
- Tailwind CSS 4.3.3 (`@tailwindcss/vite` 4.3.3) - styling; `tw-animate-css` 1.4.0 for animation
  utilities. Design tokens in `src/styles.css` (see `.context/DESIGN.md`).
- Tauri 2.9.0 (`@tauri-apps/cli`, `desktop/src-tauri`) - desktop app wrapper around the web build.
- Add to Home Screen (iPhone Safari): `public/manifest.webmanifest` (`display: standalone`, 192/512 and
  maskable icons) plus the `apple-mobile-web-app-*` / `theme-color` tags in `index.html` make the home-screen
  icon open Doop without the Safari bar. `express.static` serves it as `application/manifest+json`;
  `tests/webManifest.test.ts` builds the app and boots the production server to pin both. No service worker (offline is out of scope).
- Home (`src/pages/Home.tsx`, `src/components/HomeHero.tsx`): a 12.5px rail (canvases, workspaces,
  explore, resources, agents, an Ask Doop pill bound to ⌘/), Import + New canvas in the top bar, and
  a hero over the brand's gradient wave: the hopping Disc-D, a greeting, a strip of suggestion chips
  (the "on" chip wears the drifting colour beam from `src/styles.css`) and a composer. A prompt makes
  a canvas named after it (`src/lib/homePrompt.ts`), queues it as the first board card asking for N
  drafts, and opens the canvas; a card that cannot queue rides along as the canvas composer's draft.
  Import makes a canvas and opens it with `?import=1`, which `CanvasPage` turns into the import
  picker. `GET /api/canvases` adds `people` (owner, then members) for the tiles' avatar stacks.
  The rail is `src/components/AppRail.tsx`, mounted by Home, Automations, Integrations, Community,
  Workspace and Admin alike (a page's own group, such as a workspace's panes, goes in as children;
  Settings draws its own rail from the same `ui/dash.tsx` parts); it owns
  the ⌘K search palette (`CanvasSearchModal.tsx`), the connect-an-agent modal, the collapsed
  narrow state (remembered in `localStorage` under `doop-rail`) and the account face at the bottom.
  From another page the rail sends scope picks home as `/?scope=` and new workspaces as
  `/?workspace=new`.

## 11. Developer Experience Tooling

- oxlint 1.x + oxlint-tsgolint (type-aware rules) - lint, config in `.oxlintrc.json`; ESLint 10 with
  the typescript-eslint parser runs only the `process.env` ban in `eslint.config.js`.
- Prettier 3.9.6 - formatting (no semicolons, single quotes, printWidth 120), config in
  `.prettierrc.json`.
- Husky 9.1.7 + lint-staged 17.3.0 - pre-commit hook runs `lint-staged` (`.husky/pre-commit`).
- commitlint 21.2.2 (`@commitlint/config-conventional`) - conventional commit / PR title linting,
  config in `commitlint.config.js`.

## OSS integration scope

The integration registries currently register Linear only. Canvas imports offer websites, live-app
sync and GitHub repositories; frame exports offer PNG/JPG with progress feedback and desktop saving.
Figma, Canva and PSD are deferred. Migration 0019 is reserved for the deferred Figma integration;
the OSS journal skips it while retaining the shared migration tags and timestamps for 0020–0022.
Gemini cloud workers remain an operator-managed, opt-in pilot; see `docs/gemini-cloud-pilot.md`.
