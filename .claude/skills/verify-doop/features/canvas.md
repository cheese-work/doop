# canvas

## Sub-features

- Create (`POST /api/canvases`), open (`/c/<id>`), editor chrome: Layers panel, Pages panel.

## How to get to it (user POV)

Home, New canvas. The browser goes to `/c/<id>` and the editor loads.

## Driving it with `drive.mjs canvas`

1. Sign up, create a canvas through the API with `{name}`; the response has `id`.
2. `page.goto(/c/<id>)`, wait for `[data-slot="frame-section-heading"]` (the Layers heading).
3. Check a first `[data-page-id]` row exists; screenshot `canvas-editor.png`.

## Gotchas

- `networkidle0` is not "editor ready"; the realtime socket stays open. Wait on the selector.
- First load of a canvas can take a few seconds on a cold server; the wait allows 30 s.
