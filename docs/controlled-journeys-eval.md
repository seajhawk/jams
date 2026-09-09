# JEM → JAMS local evaluation

- Status: `succeeded`
- Session: `C:\Users\chris\Documents\JEM\JAMS hillclimb\00-browser-calibration\20260909-181329.json`
- Synchronization: validated

## Available provider metrics

| Kind | TP | FP | FN | Precision | Recall | F1 |
|---|---:|---:|---:|---:|---:|---:|
| context_switch | 8 | 0 | 2 | 1.0000 | 0.8000 | 0.8889 |

Excluded from this context-switch-only evaluation: click, keypress, scroll, sentiment, utterance, spoken_word.

## Interpretation

- Local CV provider evaluation only; no upload, database, or report UI exercised.
- Foreground/title changes are a proxy for visual task changes, not human cognition.
- Recorder-only spans and detections outside customer-app spans are excluded.
- Automated action timing is not representative of human task effort.
