Locked from doop page `che-5570` (file `mRAnnjvGod`, https://congvc-c00.taila6fa8a.ts.net:34443/c/mRAnnjvGod). Issue [CHE-5570](mention://issue/01a1d642-995b-7937-a863-0a149cdde701).
Direction B "Pinned run strip" approved by Cheese's recorded pick (issue decision record `01a1d9af-7cbf-781d-bdb5-aff8b7ef21d5`, decision `6f15db09`, card answer `d40ae1b3`, 14 Nov 2026 17:36 ICT), UX PASS on this exact frame version (verdict `01a1da26-cb47-7daf-b121-b1daccaa600d`, reviewer x99-codex-luna-design).
Lock PR publishes the approved design; UI admission requires its read-back merge SHA. The topic's last implementing PR deletes these reference files.

## Files

| File                      | Frame        | `updatedAt` (doop)         |
| ------------------------- | ------------ | -------------------------- |
| `B-pinned-run-strip.html` | `M9_tXaRCW6` | `2026-11-14T10:56:45.272Z` |

`updatedAt` is 14 Nov 2026 17:56 ICT. The frame has seven states in columns: B1 one run live, B2 run finished, B3 no runs with the agent selector open, B4 no issue, B5 Multica unreachable, B6 composer sending, B7 several runs.

## Open follow-up (not a frame change)

The UX reviewer passed this version and listed two P2 items. The lock does not change the frame for them. The implementation slice or a later design revision owns them.

1. **B7 per-run Steer path is not visible.** B7 rows show icon-only Live view and Stop, and no Steer. Either add a disabled Steer control to each row until CHE-3073 slice D, or state that Live view is the route to steer a run in a multi-run strip. B1 already shows a disabled Steer with the note "Steer is available after CHE-3073 slice D."
2. **Label each live run row in text, not only a dot.** In B7 the green dot is the only live marker on each row. Add a text label such as "Live" (sloplint 63, `index.html:237`).

## Relation to CHE-3073 slice 0

This lock approves the frame: the layout, the states and the copy of the Agents panel. CHE-3073 slice 0 builds the doop panel around that frame. The two share one lock round, as the issue's Done-when says. The panel's frame states are on the CHE-5481 and CHE-5554 doop page. Steer needs CHE-3073 slice D, so the frame shows it disabled.

## Scope notes

- **`designctl pick` was not run for this topic.** It counts only from the watcher identity (the author of the first `design-link` record on the topic issue), and CHE-5570 has no `design-link` record. Cheese's pick is recorded on the issue as decision record `01a1d9af-7cbf-781d-bdb5-aff8b7ef21d5`. Directions A and C stay on the proposal page until the pick is recorded for the lifecycle.
- **Fidelity.** The file is the `html` string the doop MCP `get_frame` returned for `M9_tXaRCW6`, transcribed by hand at 2026-11-14 20:25 ICT. A second `get_frame` read before export showed the same `updatedAt`. The file has 38197 characters, equal to the frame's `htmlBytes`, and has no trailing newline. No byte-for-byte diff against the frame was run, so a reviewer comparing against the frame is the check on this point.
- **No prettier.** The file is a verbatim export. `.prettierignore` skips `design/*/approved/*.html`.
- `content_sha256` in `LOCK.json` hashes the file bytes, with no added trailing newline.
