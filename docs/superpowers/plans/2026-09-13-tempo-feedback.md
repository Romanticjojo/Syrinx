# Tempo and Feedback Implementation Plan

> For agentic workers: use subagent-driven-development for independent audio/analysis tasks and review each deliverable. Parent owns integration and release.

**Goal:** Adjustable pitch-preserving practice tempo, responsive analysis and verified transport synchronization on both editions.
**Architecture:** A shared song-time coordinate, fixed speed per recording segment, cancellable transport operations, and background analysis.
**Tech stack:** Existing React/TypeScript, Web Audio, native media pitch preservation, Vite workers and Vitest.
**Spec:** [Tempo/feedback design](../specs/2026-09-13-tempo-feedback-design.md).

## Tasks

- [x] 1. Audio transport: test then implement `AudioEngine.setRate(rate): Promise<boolean>` for 0.5–1.5, preserve pitch and actual position, cancellation, same gain/analyser, local encoded audio lifecycle. Own AudioEngine and new audio helper/tests only. `load` resets rate to 1. Read `rate` remains available.
- [x] 2. Pitch pipeline: benchmark current extraction, test then optimize `extractPitchTrackAsync` and chart/scoring hot paths. Keep function compatibility; add optional `onProgress(fraction)` and `signal` cancellation. Own pitch/* and PitchChart* only. Do not edit ResultPage or shared types. Return raw recording-local time plus existing offset convention; parent maps BPM after extraction.
- [x] 3. Parent integration: test recording rate metadata and replay mapping; implement tempo panel in ControlBar and PerformPage transaction, protect keyboard inputs, update ResultPage rate mapping/progress and segment labels. Existing seek race tests remain green. Review tasks 1–3 together for actual clock/recording alignment.
- [x] 4. Run full tests, lint and both builds; built-in browser test original/changed BPM, reset, playback/paused measure jumps, rapid inputs and responsive layouts. Capture screenshot evidence. Record measured performance improvement and precise limitations.
- [ ] 5. Finish bilingual README/images and release notes; merge into dev and web-deploy preserving web four-song configuration and library gate. Documentation-only update master. Tag and push all authorized branches, verify remote refs.

## Integration rulings

Task 1 → 3: async setRate success is awaited before count-in, invalidation remains latest-intent only. Task 2 → 3: extracted local seconds are mapped once; cached points already use song time. No shared source-file ownership between parallel implementers. Each task's tests target observable behavior, with comparison measurements outside timing-sensitive CI assertions.

User explicitly authorized implementation and pushes; the skill's generic approval pauses are unnecessary here. Preserve unrelated main-workspace designs and all personal-library user data.
