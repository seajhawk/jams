# Whisper Local Benchmark

Local baseline for the F3-b3 transcription provider. The ACA SKU benchmark remains a deploy-time gate.

- Fixture: `(Audio) SettingUpGoogleVideoAnalyzerForContextSwitches-ShotChange.m4a`
- Model cache: `C:\Users\chris\.cache\jams-worker\faster-whisper`

| Model | RTF | Wall time (s) |
|---|---:|---:|
| distil-small.en | 0.1366 | 17.01 |
| small.en | 0.3323 | 41.38 |

```json
[
  {
    "model": "distil-small.en",
    "rtf": 0.1366,
    "wall_time_s": 17.01
  },
  {
    "model": "small.en",
    "rtf": 0.3323,
    "wall_time_s": 41.38
  }
]
```
