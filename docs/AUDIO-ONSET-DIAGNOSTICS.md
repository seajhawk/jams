# Audio proposal diagnosis

This local diagnostic exports the unchanged detector's proposals, one-to-one
timestamp matches, feature medians, precision and recall. It does not run an LLM
or transcription. Its measurements are **before visual verification**, not final
click-provider accuracy. The existing pytest acceptance gate remains authoritative.

Generate the standard fixtures with `worker/scripts/make_fixtures.py` (espeak-ng
is required for narrated fixtures), then run from the repository root:

```powershell
uv run --project worker python worker/scripts/diagnose_audio_onsets.py --fixture-dir D:/Temp/jams-fixtures --output D:/Temp/jams-audio-diagnosis/baseline.json
```

The command writes JSON plus cached onset artifacts alongside it. Reuse the same
fixture directory across experiments; cache keys include audio bytes, speech
regions, parameters and builder version. Update the builder version if changing
its algorithm. Missing controls or click ground truth raise an error; unavailable
TTS is explicitly reported as skipped. This is a diagnostic command: a completed
report can contain `gate_passed: false`; command success does not mean acceptance.

## Baseline, September 12, 2026

| Fixture | True positives | False positives | False negatives |
|---|---:|---:|---:|
| Clean click transients | 6 | 0 | 0 |
| Narrated clicks | 6 | 126 | 0 |
| Pure speech | 0 | 130 | 0 |
| Silence / tones / music (each) | 0 | 0 | 0 |

Narrated precision is 0.04545, below the unchanged 0.85 gate; recall is 1.0.
The dedicated golden test reproduced exactly the diagnostic counts on freshly
generated fixtures. No detector parameters or acceptance thresholds changed.

Matched narrated proposals have median spectral flatness 0.710 versus 0.243 for
unmatched proposals, and median centroid 4226 versus 2909 Hz. Both groups have
median decay capped at 60 ms: requiring short decay would discard real clicks
under narration. These are exploratory observations on one synthetic phrase,
not validated classification rules.

Next: test transient contrast and spectral shape using held-out phrases, voices
and signal levels, alongside the clean-click and negative controls. Keep the
broad speech-region stress test and its current gates. Report final visual-fusion
precision separately; the runtime currently suppresses in-speech proposals without
visual corroboration. Do not relabel raw candidates to manufacture a gate pass.

## Expanded synthetic experiment

Generate and then evaluate sequentially (do not regenerate media during evaluation):

```powershell
uv run --project worker python worker/scripts/make_audio_holdouts.py --output-dir D:/Temp/jams-audio-holdouts
uv run --project worker python worker/scripts/evaluate_audio_holdouts.py --fixture-dir D:/Temp/jams-audio-holdouts --output D:/Temp/jams-audio-holdouts/evaluation.json
```

There are 27 cases: three new repeated phrases, three voice/speed combinations,
and three transient-to-speech levels (-12, -6, 0 dB). Each 24-second pair contains
pure narration and that same narration plus six seeded clicks. Shared peak scaling
preserves the pair's speech amplitude. The manifest records local speech RMS over
400 ms centered on each click; this does not prove speech at the exact click sample.
Mix levels use whole-track speech RMS and active-transient RMS, matching the original
fixture convention. These synthetic voices are robustness probes, not customer audio.

Final shared-normalization results (162 expected clicks), September 12:

| Fixed experiment | TP | FP | FN | Precision | Recall | Pure-speech proposals |
|---|---:|---:|---:|---:|---:|---:|
| Unchanged baseline | 162 | 3740 | 0 | 4.15% | 100% | 3823 |
| In-speech threshold multiplier 3.2 | 132 | 257 | 30 | 33.93% | 81.48% | 268 |
| Flatness ≥0.6 and crest ≥4 | 111 | 623 | 51 | 15.12% | 68.52% | 648 |

Both alternatives are rejected for production. They were chosen before this
evaluation, and neither reaches the existing precision gate. The original
narrated acceptance failure remains unchanged. Once inspected, this corpus is
development evidence; future tuning needs fresh held-out data.
