# Personal Score Library Implementation Plan

> Execute independent units with dispatching-parallel-agents, then review and integrate in this session. Use test-driven-development and verification-before-completion. User approval includes implementation and integration into dev; do not request another design gate.

**Goal:** Deliver an offline personal score library in the desktop edition, with a formal-version notice in the web edition. User refinements supersede the original automatic-arrangement scope.

**Specifications:** ../specs/2026-09-13-personal-library-design.md and ../specs/2026-09-13-personal-library-scope-update.md.

## Constraints

- Preserve web-deploy and the cloud server. Keep the frozen baseline tag and external media snapshot.
- No account, upload endpoint or remote generation. Preserve original MusicXML and keep only active audio in memory.
- Use the current visual tokens. Develop in desktop mode; ordinary production build remains web.
- Finish through in-app-browser Computer Use. Preserve the main workspace's unrelated designs directory.

## Completed implementation

- [x] Freeze and push the existing dev version and annotated baseline tag; verify the external Git bundle and media manifest.
- [x] Install and apply development, design, planning, review and verification skills; use the requested Computer Use skill for real UI testing.
- [x] Build IndexedDB repository with deduplication, transaction completion, v1 upgrade, folders, covers and versioned backup/restore.
- [x] Parse bounded MusicXML/MXL with explicit handling of simultaneous notes, voices, staff, ties, pickup, tempo changes and common repeats.
- [x] Preserve pure melody as a static electronic sheet, without audio preparation or performance controls.
- [x] Select exactly one existing piano part and synthesize its accompaniment locally; remove user-facing automatic-arrangement controls.
- [x] Integrate the active personal score with existing score rendering and performance entry. Keep the curated catalog intact.
- [x] Exclude personal modules from web builds; show a formal-version notice on the personal tab.
- [x] Implement cards, recent shelf, compact list, pagination, search, favorites, sorting and metadata editing.
- [x] Implement local cover selection, resizing, replacement/removal, book-cover display and list thumbnails.
- [x] Implement flat folder creation, rename, batch moves and safe folder removal to Unfiled.
- [x] Adapt phone/tablet/foldable widths, portrait/landscape and short-height dialogs, with preserved drafts and reading state.
- [x] Review storage, music engine and combined UI; fix editor response races, missing rendering XML declaration and zoom reload lifecycle.

## Verification and handoff

- [x] Functional Computer Use walkthrough: user MXL import, reading, metadata, cover, folders, duplicate/invalid handling, v1/v2 restore and one-piano performance.
- [x] Restore 120 isolated QA scores to verify 24/50-per-page card/list browsing and cross-page search.
- [x] Resize the current test tab through phone, iPad and foldable dimensions; inspect DOM bounds and visible screenshots, without using hidden state mutations.
- [x] Run full tests, lint and both production builds; see ../reports/2026-09-13-personal-library-validation.md for final counts and limits.
- [x] Document that in-app backup download completion is unconfirmed; do not claim a completed download/restore round trip.
- [x] Document that physical mobile devices, hinge posture, OS keyboard, airplane-mode cold start, audio listening and native installers are not covered by viewport simulation.

## Integration procedure

Commit only the scoped application and documentation changes, fast-forward the primary dev checkout, verify the merged checkout, then push dev to the existing GitHub repository. Confirm the remote baseline tag and web-deploy SHA remain unchanged. Keep the external worktree and localhost preview for user review.
