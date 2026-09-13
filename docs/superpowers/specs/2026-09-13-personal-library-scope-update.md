# Personal library scope update — 2026-09-13

The user approved these refinements during local acceptance testing. They replace the original automatic-arrangement scope.

- A melody-only flute score is an electronic sheet. Opening, paging, zooming and editing it must never prepare an audio buffer, create an AudioContext or expose performance/playback buttons.
- Accompaniment supports exactly one existing piano part; its left and right staves remain together. No generated-arrangement, key or texture controls are exposed. Older experimental settings normalize to this simpler behavior.
- Edit title, composer/arranger, tags, folder and cover image locally. Metadata edits preserve the original imported MusicXML.
- Flat folders support create, rename, atomic multi-score moves and removal that returns scores to Unfiled. Removing a folder never removes its scores. Empty folders are persisted and backed up.
- Optional PNG/JPEG/WebP covers are decoded and resized locally, longest edge at most 800 px, encoded image at most 512 KiB. Reject SVG, remote URLs, files above 10 MiB and images above 24 megapixels. Covers use the existing book proportions, subtle title shading and a small thumbnail in list mode; absent images use the existing typographic cover.
- Card and list views have 24 and 50 records per page. Browsing reads summaries rather than all original XML/cover blobs; only visible cards retrieve covers. View choice is saved locally.
- IndexedDB v2 preserves v1 score records, adds folders, and accepts optional folder/cover fields. Version 2 backups include folders/covers; version 1 backups remain importable. Large exports split at the actual UTF-8 JSON byte limit.
- Web builds keep the Personal Library tab as a formal-version notice. Work remains on dev; web-deploy and the hosted server are not deployment targets.
- Final acceptance uses Computer Use through the Codex in-app browser, with real user file selection, visible UI checks, responsive layouts, folder/cover/list flows, score reading and one-piano playback. Native Chrome automation failed URL recognition and is no longer the test route.
- Additional user request: adapt phone portrait/landscape, iPad, and foldable closed/open widths. Width changes preserve reading page/zoom and unsaved metadata. Dialogs remain scrollable at short heights, primary touch controls target at least 44 px, and safe-area insets are respected. Verify with exact viewport dimensions in the selected in-app test tab; viewport resizing is not a claim of physical hinge, mobile OS or virtual-keyboard hardware testing.
