# Personal library and measure practice refinement

The user approved measure seeking with segmented recordings and requested a simpler library consistent with Syrinx's dark, teal, editorial visual style. This is architectural work because recording ownership and score interaction span several components. Existing authorization covers implementation, verification and integration into dev; web-deploy remains untouched.

## Library interaction

Make importing, finding and opening scores primary. Keep the existing cover artwork, typography, palette and offline data model. Remove the duplicate recent shelf and decorative informational clutter. Show title and composer on normal cards; put editing, moving, favorite and removal behind an accessible per-score action button. Show checkboxes and bulk actions only in an explicit selection mode. A compact folder selector and management menu replace unbounded folder chips. Preserve search, favorites, sorting, list/card view, pagination, metadata/covers, folder management, and backup/restore. Menus work by keyboard, dismiss on Escape/outside interaction and restore focus. All important touch targets remain at least 44 px; narrow screens must not overflow.

## Measure practice

Tap or click a real measure to seek to its start. While paused remain paused and show the selected position. While playing, seal the current recorded segment, pause accompaniment, seek, count in four beats and resume with a fresh segment. Progress seeking and restart use the same segment-preserving transition. Commit one seek per drag gesture; dragging, scrolling and pinch gestures on the sheet do not seek. Read-only flute scores remain electronic sheets without generated audio.

Keep each recording segment and its own score start/stop positions. Replay and analyze a selected segment against that same accompaniment interval; excluded time never participates in analysis. Late asynchronous saves or analysis may not overwrite another performance or another segment. Segment boundary sealing must drain worklet chunks before finalizing without closing the microphone stream. Clean up all object URLs when no longer owned. Interrupting a countdown, repeated seeks, ending, and unmounting must not restart playback unexpectedly.

## Integration contract

ScoreSheet adds optional `onMeasureSelect(measure: number, time: number): void`, forwarded to OSMDScore through a current callback. The time comes from the score's supplied measure timeline and excludes the end sentinel. Selection hit testing uses actual rendered geometry and client coordinates, accounts for responsive scaling and scroll, and is inactive without the callback. Score geometry task owns ScoreSheet/OSMDScore and their tests/styles only. Recording task owns recorder/types/store/PerformPage/ResultPage and their tests/styles. Library task owns library presentation and its tests/styles. Preserve backwards-compatible single-take behavior where useful, but segmented state must explicitly identify each segment.

## Validation

Meaningful automated tests cover boundaries, recording segment ownership/flush, seek lifecycle, selected-segment playback/scoring, gesture hit testing, menu/selection interactions and pagination. Run full tests, lint and both builds. Finally use Computer Use in the Codex built-in browser on localhost, including actual clicks and responsive viewport checks on phone, tablet/foldable and desktop. Report simulated versus actual audio/hardware verification accurately.
