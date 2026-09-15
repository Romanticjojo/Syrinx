# Pitch extraction comparison — 2026-09-13

Manual measurement on this Windows workstation, Node 24.14.1. Run from `app`
with Node 24+: `node src/pitch/benchmark.mjs`. These are observations, not CI
wall-clock assertions or device-wide guarantees.

The deterministic 44.1 kHz fixture contains flute-range half-second notes,
three harmonics, amplitude envelopes, 5 Hz vibrato and seeded breath noise.
The same one-second warm-up precedes both 30- and 60-second comparisons.

| Audio | Stage | Before (ms) | After (ms) |
| --- | --- | ---: | ---: |
| 30 seconds | Synchronous extraction | 1125.35 | 171.62 |
| 30 seconds | Async fallback extraction | 1485.44 | 199.87 |
| 30 seconds | Scoring | 3.22 | 3.87 |
| 60 seconds | Synchronous extraction | 2453.99 | 306.99 |
| 60 seconds | Async fallback extraction | 3179.88 | 348.96 |
| 60 seconds | Scoring | 3.07 | 2.94 |

Async extraction improved about 7.4× / 9.1× in these runs. A separate post-change
run measured 187.09 / 356.84 ms, illustrating ordinary runtime variation.
Before the change, the chart's two target-activity lookup passes took only
0.58 / 2.88 ms. Neither scoring nor chart lookup explains the observed delay;
their behavior and complete input sample sets remain unchanged.

The detector now evaluates difference values and normalization together,
stops at the first qualifying valley, and bounds offline lag search to the
existing 180 Hz floor. It retains the original integration window, frame hop,
thresholds and parabolic interpolation. The public live detector keeps its
full frequency range by default.

Before and after: 1,268 / 2,536 retained track points and 0.463 / 0.484 average
absolute cents in the fixture. Synchronous and asynchronous outputs match
exactly. A separate comparison of 510 harmonic frames spanning 60–3,000 Hz at
16 / 44.1 / 48 kHz found zero differences in retained outputs versus the original
detector. Regression tests additionally cover low/high pitches, noise, silence,
real worker execution, unchanged source audio, progress, cancellation, worker
termination, startup failure and responsive fallback.

Browsers use a dedicated module Worker, which keeps this computation off the
UI thread. These timing measurements cover the Node fallback only; they exclude
recording decode, worker startup, browser paint and playback. They are synthetic
signal checks, not validation with a microphone or mobile hardware.
