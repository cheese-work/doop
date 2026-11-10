# pages

## Sub-features

- Add page, duplicate, rename, reorder, delete (`src/components/PagesPanel.tsx`). Only Add page is driven.

## How to get to it (user POV)

Open a canvas. The Pages section sits at the top of the left panel; the plus button adds a page named `Page N`.

## Driving it with `drive.mjs pages`

1. Open a canvas (see canvas.md) and count `[data-page-id]` rows.
2. Click `button[aria-label="Add page"]`; wait until the count is one higher.
3. Reload; wait for `[data-page-id]`; the count is still one higher (saved on the server).
4. Screenshots: `pages-before.png`, `pages-after-add.png`, `pages-after-reload.png`.

## Gotchas

- The row is a `div` with `data-page-id`, not a button. Rename and delete are context-menu items.
- Add page is disabled while a save is in flight (`busy`); wait for the count, not a fixed sleep.
