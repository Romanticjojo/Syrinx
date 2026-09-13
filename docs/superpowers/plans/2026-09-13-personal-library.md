# Personal Score Library Implementation Plan

> Execute independent units with dispatching-parallel-agents, then review and integrate in this session. Use test-driven-development and verification-before-completion. User approval includes implementation and integration into dev; do not request another design gate.

**Goal:** Deliver a local personal score library in the desktop edition and a formal-version notice in the web edition.
**Architecture:** Existing React/OSMD/audio experience plus a local repository, independent MusicXML/piano engine, and a runtime song adapter. Web builds exclude personal modules at compile time.
**Tech Stack:** Existing Vite/React/TypeScript/Vitest; IndexedDB; fflate for bounded MXL decoding; procedural piano synthesis.
**Spec:** ../specs/2026-09-13-personal-library-design.md

## Global constraints

- Preserve web-deploy and the cloud server. Preserve existing curated song and recording behavior.
- No account, upload endpoint, cloud generation, or dependency on remote runtime fonts/sounds.
- Binding visual tokens: app/src/index.css. Development defaults to desktop mode; build defaults to web mode.
- Runtime sources contain no persistent Blob URLs. Store originals and settings; cache only active audio.
- Reviewers inspect behavior, lifecycle, import validation, musical timing, edition isolation and mobile layout.

## Task 1: Local records and backup (independent)

**Files:** app/src/library/types.ts (shared contract); repository.ts; backup.ts; repository.test.ts; backup.test.ts.
**Interface:** PersonalScore and ScoreSettings in types.ts. repository exports createScoreRepository(name?), scoreRepository; list(), get(id), add(record) -> {record, duplicate}, update(id, patch) -> record, remove(id), restore(records) -> {added, skipped}. backup exports encodeBackup(records):string and decodeBackup(text):PersonalScore[].
- [ ] Write tests using fake-indexeddb for reopen persistence, duplicate hash, missing update, transaction failure, atomic restore and version/record validation.
- [ ] Run focused tests before implementation and record expected missing behavior.
- [ ] Implement bounded validation and transaction-completion promises. Dedupe by fingerprint, never overwrite existing metadata on duplicate restore.
- [ ] Verify focused tests and submit file-scoped review; no package or shared UI edits.

## Task 2: MusicXML and piano engine (independent)

**Files:** app/src/library/score.ts; files.ts; piano.ts; corresponding tests and fixtures.
**Interface:** inspectScore(xml):ScoreInspection; prepareScore(xml, settings):PreparedScore; readScoreFile(file):Promise<string>; synthesizePiano(timeline, signal?):Promise<AudioBuffer> (all contracts in types.ts).
- [ ] Hand-write small fixtures: melody+two-staff piano, simultaneous chord notes, backup voice, tied notes, tempo boundary, weak pickup, repeats, harmony, invalid XML, mismatched settings.
- [ ] Assert literal onset/duration/pitch values, validate duration of silent mode and separation of melody from piano. Observe failures before implementation.
- [ ] Implement bounded multi-part analysis and a shared beat/tempo representation. Preserve original XML and build playback-order melody XML separately.
- [ ] Implement original piano notes, deterministic generated piano and silent accompaniment, plus cancellable offline synthesis. Do not change legacy parsers.
- [ ] Test compressed container discovery/path/size bounds using fflate fixtures, malformed files and unsupported notation messages.
- [ ] Run focused tests, report exact support limits and review all owned files.

## Task 3: Edition and source integration (controller)

**Files:** app/package.json; app/vite.config.ts; src/App.tsx; src/store.ts; src/songs/runtime.ts; src/songs/index.ts; src/audio/accompaniment.ts; src/library/bridge.ts; app views as necessary.
- [ ] Add behavioral tests for web-tab notice and desktop tab selection; verify failure.
- [ ] Add compile-time desktop mode, preserving ordinary production as web.
- [ ] Introduce a single active runtime song (manifest/XML/timeline/audio provider) and resolve it before curated catalog lookups. Personal library prepares and registers it before go('perform').
- [ ] Ensure cancel, repeated entry, result analysis and accompaniment comparison work for runtime songs. Preserve existing curated loader tests.
- [ ] Build both modes; inspect web assets for excluded private modules and exercise web notice.

## Task 4: Personal library UI (controller)

**Files:** src/library/PersonalLibrary.tsx; LibraryImport.tsx; LibraryDetail.tsx; library.css; src/components/Dialog.tsx; src/views/HomePage.tsx/css; UI tests.
- [ ] Implement confirmed visual direction directly in the actual app using existing tokens, avoiding a separate throwaway prototype.
- [ ] Empty state with import/restore, Netflix-inspired recent shelf and score cards, filters/search/sort, metadata edit/favorite/delete.
- [ ] Import configuration selects melody/piano/mode/style/key and saves only valid confirmed records. Progress, cancellation and per-file errors are visible.
- [ ] Detail renders XML through ScoreSheet, switches full/melody/piano and handles zoom, exports original, saves settings and launches existing performance flow.
- [ ] Dialog lifecycle, error dismissal, duplicate handling and backup restore receive behavior tests plus real-browser validation.

## Task 5: Review, verification and integration

- [ ] Full tests, lint and web/desktop production builds. Check all new failures; document existing warnings.
- [ ] Browser functional walkthrough including reopen/backup/restore and offline requests; 390/768/1440 viewport and both themes.
- [ ] Independent review of local storage and music engine, followed by whole-change review; fix important findings and verify scoped regressions.
- [ ] Save docs/superpowers/reports/2026-09-13-personal-library-validation.md with evidence and limitations.
- [ ] Commit file-scoped changes, fast-forward dev, verify main workspace and remote web-deploy unchanged. Push dev if requested scope includes final integration backup; never deploy.
