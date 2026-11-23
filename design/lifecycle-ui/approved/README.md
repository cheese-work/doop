Locked from doop page `che-5478` (file `TgQKWNP_e3`, https://congvc-c00.taila6fa8a.ts.net:34443/c/TgQKWNP_e3). Issue [CHE-5478](mention://issue/01a1d42f-b225-7764-bf3a-36ebbe25eee5).
Direction A "Quiet in place" approved by Cheese's recorded pick (issue decision record `01a1d873-0ad1-76c4-b2d6-774d3ad0c2fa`, decision `82fd535d`), UX PASS on these exact frame versions (verdict `01a1d885-ea2c-790f-9549-45da97807561`, reviewer x99-codex-luna-design).
Lock PR publishes the approved design; UI admission requires its read-back merge SHA. The topic's last implementing PR deletes these reference files.

## Files

| File                         | Frame        | `updatedAt` (doop)         |
| ---------------------------- | ------------ | -------------------------- |
| `A1-frame-lock.html`         | `Dx0dkXCQdJ` | `2026-11-13T11:55:52.343Z` |
| `A2-archive-and-trash.html`  | `ihyEfz5eKc` | `2026-11-14T05:04:50.384Z` |
| `A3-page-snapshots.html`     | `i42zJDTQ6k` | `2026-11-14T05:03:54.440Z` |
| `A4-comment-resolution.html` | `ozJA_LNVyn` | `2026-11-14T05:03:49.527Z` |
| `A5-project-ledger.html`     | `oQjlN1W4mM` | `2026-11-14T05:03:52.024Z` |
| `A-phone-390-all-five.html`  | `TWLkRxuIds` | `2026-11-13T11:56:04.256Z` |

Frames A2 to A5 changed after the first UX PASS. The reviewer re-confirmed PASS on A1 to A5 and the phone board at the `updatedAt` values above.

## Scope notes

- **A5 (project ledger) stays in this lock.** Cheese's pick covered the five desktop frames and the phone board. The planner's proposal to move the ledger to the branching spec (issue comment `01a1d573-df11-7cbf-aa4f-9493826ea3e0`) has no answer from Cheese. If Cheese accepts it later, a follow-up PR removes `A5-project-ledger.html` and its phone column.
- **Fidelity.** Each file is the `html` string the doop MCP `get_frame` returned for that frame, written byte for byte by script at 2026-11-14 13:02 ICT, after checking that the frame's `updatedAt` equals the value above. The character count of each file equals the frame's `htmlBytes`: A1 21614, A2 21691, A3 22381, A4 22146, A5 19192, phone 27439. An earlier hand-retyped export was identical to this one apart from a trailing newline.
- **No prettier.** These files are verbatim exports. `.prettierignore` skips `design/*/approved/*.html`, like the Blitz fixtures line.
- `content_sha256` in `LOCK.json` hashes the file bytes, with no added trailing newline.
