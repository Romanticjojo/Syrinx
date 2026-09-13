# Tempo, recording and feedback validation · 2026-09-13

## Scope

Both editions share measure selection, pitch-preserving tempo control, recording segments and result analysis. The desktop feature mode includes the local personal library; the web build shows its full-version notice. This release also retires two dev featured songs and updates both README languages.

## Synchronization rules checked

- Accompaniment provides the song clock for score cursor, progress and capture coordinates.
- Seeking while stopped stays stopped. Seeking while playing seals the current recording, cancels the previous transition and counts in at the target.
- Applying BPM uses the same transition. Each completed segment stores its own playback rate; chart and replay convert between recording seconds and song seconds once.
- Old resume, countdown, media play, recording gate and analysis completions cannot restart a cancelled operation or overwrite the selected segment.
- The recording indicator lights only after capture has actually begun, and goes out while paused. Permission and capture errors are visible.
- Comparison playback corrects startup delay against the recording's current time after both audio paths start. Correcting an active native media position does not restart its decoder.
- Native time quantization cannot move a paused seek or a new recording start just before the requested measure. Paused position remains exact; active media time is bounded by the latest explicit start. A timestamp 1 ns before an unrelated measure boundary still stays in the earlier measure.

## Automated checks

- Full test suite: **58 files, 567 tests passed** after the final clock-boundary fix.
- TypeScript and both web/desktop production builds passed; web output excludes the PersonalLibrary chunk and both outputs include the analysis Worker.
- Lint completed with **13 existing warnings**, none introduced by the modified production code.
- Focused recording/transport/score/result review: 173 tests passed. New race, capture-state and boundary regressions were observed failing before their fixes.

## Built-in browser interaction

Computer Use operated the application's actual controls. Original project MusicXML examples were used in separate localhost origins; existing user-library data was not modified.

- Imported a flute/piano example through the file chooser and saved its selected piano part.
- Applied 42 and 60 BPM, restored the recommended 84 BPM, and rejected out-of-range input.
- Paused during playback, selected measure 5 while paused, resumed, clicked measures 7 and 3 in succession while playing, changed tempo and stopped.
- Verified four recorded segments remained selectable, with 50% and 71% rate labels, individual durations and rendered pitch comparisons.
- Started comparison playback, paused the recording, inspected its paused media state, and switched to another segment.
- Verified 320×740, 390×844, 540×720, 768×1024, 820×1180 and 1024×768 layouts: no horizontal page overflow and all six toolbar buttons at least 44 px high. The 320 px check also included the active REC badge. The BPM dialog was inspected at 320×640.
- Final boundary retest: selected measure 5 at 42 BPM, started, paused and selected it again. The paused HUD remained on measure 5. The visible recording metadata retained `startSec: 11.428571428571429`, rate `0.5`; the completed replay correctly showed measure 5 rather than measure 4.

The full recording flow used a separate test build of the actual application, with only its microphone module replaced by a deterministic local 440 Hz capture adapter. It produced real WAV segments and used the actual transport, views, storage, score rendering and analysis code. The page visibly identified synthetic recording. This verifies integration without claiming a physical microphone test. A normal production preview played audio and advanced the cursor, but did not yield a microphone recording; its permission/input state could not be conclusively resolved in this environment.

## Native audio and background analysis

A separate production-built validation page imported the actual AudioEngine and analysis modules. Tests were started with visible buttons and used locally generated signals.

| Audio path | Expected rate | Observed clock ratio | Observed frequency | Paused seek targets |
|---|---:|---:|---:|---|
| Initial AudioBuffer | 1.0 | 0.998 | 440.02 Hz | 2.000 / 10.000 s |
| Native media | 0.5 | 0.499 | 440.02 Hz | 2.000 / 10.000 s |
| Native media, restored | 1.0 | 0.998 | 440.02 Hz | 2.000 / 10.000 s |
| Native media | 1.5 | 1.520 | 440.02 Hz | 2.000 / 10.000 s |

All met the predefined tolerances of ±10 Hz, ±0.10 clock ratio and ±0.05 s positioning. These short measurements confirm pitch preservation and the rate-dependent clock, not device-wide latency guarantees.

A 60-second, 48 kHz synthetic flute-like signal produced 2,584 points in **0.519 seconds**, averaging 440.01 Hz. The emitted hashed production Worker sent 19 progress messages and one completion, with no worker error; it was terminated after completion. Cancellation through the visible button also returned the page to an available state.

The separate Node benchmark reduced a 60-second fixture from approximately 3.18 seconds to 0.35 seconds with identical retained point counts and pitch accuracy checks. See [benchmark details](../../../app/src/pitch/benchmark.md). Browser and Node measurements use different sample fixtures and must not be treated as a direct cross-runtime comparison.

## Limits

- Viewport emulation does not certify physical iPhone/iPad/Android/foldable hardware, audio routing or microphone latency.
- Native pitch preservation depends on the browser; unsupported preparation reports an error while preserving the stopped state.
- Existing large score-rendering bundle warnings and unrelated lint warnings are tracked separately from this change.
- Source/tag pushes do not deploy the cloud site or create native installers.
