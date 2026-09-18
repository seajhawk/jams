# Journey corpus — 56 designed journeys

Generated 2026-09-18. Full definitions (timed action beats, line-by-line narration with a declared
sentiment per line, expected signals) are in `corpus.json`. Each narration script doubles as the
reference transcript for WER and the label set for sentiment macro-F1, since JEM captures no audio.

**Not yet captured, and not yet critiqued** — the coverage, validity and logistics critics have not
completed. Treat as a design draft. See `JEM-EVAL-RESCORE-2026-09-18.md`: a journey only exercises
the context-switch detector if its transitions produce a real visual change, and these journeys
were designed before that was measured.

| id | min | switches | /min | segs | narration | apps |
|---|---:|---:|---:|---:|---:|---|
| `adversarial-edge-01` | 6 | 10 | 1.7 | 4 | 16 | Microsoft Edge, Windows Terminal (monitor 2 only, fixture server), JEM (monitor 2 only) |
| `adversarial-edge-02` | 8 | 17 | 2.1 | 5 | 20 | Visual Studio Code, Windows Terminal, Notepad++ |
| `adversarial-edge-03` | 12 | 11 | 0.9 | 4 | 11 | Visual Studio Code, Windows Calculator, Notepad++ |
| `adversarial-edge-04` | 7 | 6 | 0.9 | 3 | 24 | Visual Studio Code, Windows Terminal, JEM (monitor 2 only) |
| `adversarial-edge-05` | 9 | 16 | 1.8 | 5 | 21 | Microsoft Edge, Windows Terminal, Notepad++ |
| `adversarial-edge-06` | 5 | 90 | 18.0 | 6 | 13 | Microsoft Edge, Windows Terminal, Visual Studio Code |
| `adversarial-edge-07` | 10 | 22 | 2.2 | 6 | 34 | Microsoft Edge, Notepad++, Visual Studio Code |
| `adversarial-edge-08` | 8 | 20 | 2.5 | 5 | 21 | Microsoft Edge (two windows), Notepad++ (two tabs), Visual Studio Code |
| `browser-research-01` | 6 | 4 | 0.7 | 4 | 22 | Microsoft Edge, JEM recorder, external microphone recorder |
| `browser-research-02` | 11 | 20 | 1.8 | 7 | 33 | Microsoft Edge, JEM recorder, external microphone recorder |
| `browser-research-03` | 5 | 29 | 5.8 | 5 | 18 | Microsoft Edge, JEM recorder, external microphone recorder |
| `browser-research-04` | 12 | 5 | 0.4 | 4 | 15 | Microsoft Edge, JEM recorder, external microphone recorder |
| `browser-research-05` | 8 | 6 | 0.8 | 5 | 27 | Microsoft Edge, JEM recorder, external microphone recorder |
| `browser-research-06` | 7 | 11 | 1.6 | 5 | 16 | Microsoft Edge, Notepad, JEM recorder |
| `browser-research-07` | 6 | 3 | 0.5 | 4 | 14 | Microsoft Edge, JEM recorder, external microphone recorder |
| `dev-terminal-01` | 10 | 12 | 1.2 | 5 | 22 | Windows Terminal (pwsh 7.6.6, two named tabs), Visual Studio Code 1.126 (Dark Modern), git 2.55 |
| `dev-terminal-02` | 8 | 12 | 1.5 | 6 | 18 | Visual Studio Code 1.126 (Dark Modern, integrated terminal), Windows Terminal (pwsh 7.6.6), Node v26.7.0 |
| `dev-terminal-03` | 12 | 21 | 1.8 | 7 | 27 | Windows Terminal (pwsh 7.6.6, two named tabs), Visual Studio Code 1.126 (Dark Modern, three-way merge editor), git 2.55 |
| `dev-terminal-04` | 13 | 18 | 1.4 | 6 | 31 | Windows Terminal (pwsh 7.6.6), Visual Studio Code 1.126 (Dark Modern), Microsoft Edge (clean profile, dark, exactly two tabs) |
| `dev-terminal-05` | 17 | 11 | 0.6 | 5 | 16 | Windows Terminal (pwsh 7.6.6, two named tabs), Visual Studio Code 1.126 (Dark Modern), Next.js build via npm |
| `dev-terminal-06` | 4 | 13 | 3.2 | 4 | 10 | Windows Terminal (pwsh 7.6.6), Visual Studio Code 1.126 (Dark Modern), Node v26.7.0 |
| `dev-terminal-07` | 14 | 24 | 1.7 | 7 | 21 | Windows Terminal (pwsh 7.6.6, three named tabs), Visual Studio Code 1.126 (Dark Modern), Windows Task Manager |
| `duration-extremes-01` | 3.3 | 8 | 2.4 | 4 | 11 | Microsoft Edge, Windows Terminal (PowerShell 7, profile jem-shell), Visual Studio Code |
| `duration-extremes-02` | 4.2 | 18 | 4.3 | 6 | 20 | Microsoft Edge, Visual Studio Code, Windows Terminal (PowerShell 7, profile jem-shell) |
| `duration-extremes-03` | 17.4 | 42 | 2.4 | 7 | 36 | Microsoft Edge, Visual Studio Code, Windows Terminal (PowerShell 7, profile jem-shell) |
| `duration-extremes-04` | 17.1 | 9 | 0.5 | 5 | 24 | Microsoft Edge, Visual Studio Code |
| `duration-extremes-05` | 11.2 | 6 | 0.5 | 4 | 14 | Windows Terminal (PowerShell 7, profile jem-shell), Visual Studio Code, Microsoft Edge |
| `duration-extremes-06` | 7.5 | 12 | 1.6 | 5 | 17 | Microsoft Edge, Windows Terminal (PowerShell 7, profile jem-shell), Visual Studio Code |
| `friction-sentiment-01` | 10 | 17 | 1.7 | 6 | 32 | Windows Terminal (PowerShell 7, dark), Visual Studio Code (Dark+), Microsoft Edge (InPrivate window, dark) |
| `friction-sentiment-02` | 5 | 4 | 0.8 | 4 | 15 | Windows Terminal (PowerShell 7, dark, two tabs), Visual Studio Code (Dark+) |
| `friction-sentiment-03` | 16 | 10 | 0.6 | 3 | 21 | Visual Studio Code (Dark+), Windows Notepad (Windows 11, dark), Windows Terminal (PowerShell 7, dark) |
| `friction-sentiment-04` | 8 | 11 | 1.4 | 4 | 20 | Visual Studio Code (Dark+), Windows Terminal (PowerShell 7, dark, Python REPL) |
| `friction-sentiment-05` | 7 | 9 | 1.3 | 4 | 19 | Windows Terminal (PowerShell 7, dark), Visual Studio Code (Dark+) |
| `friction-sentiment-06` | 12 | 13 | 1.1 | 5 | 31 | Windows Terminal (PowerShell 7, dark), Visual Studio Code (Dark+) |
| `friction-sentiment-07` | 6 | 15 | 2.5 | 4 | 18 | File Explorer (Windows 11, dark mode) |
| `friction-sentiment-08` | 9 | 5 | 0.6 | 4 | 20 | Windows Terminal (PowerShell 7, dark), Microsoft Edge (InPrivate window, dark) |
| `multi-app-switching-01` | 8 | 14 | 1.8 | 3 | 16 | EXCEL.EXE, msedge.exe |
| `multi-app-switching-02` | 9.5 | 22 | 2.3 | - | 16 | Acrobat.exe, WINWORD.EXE |
| `multi-app-switching-03` | 12.5 | 23 | 1.8 | 3 | 20 | OUTLOOK.EXE, notepad++.exe, msedge.exe |
| `multi-app-switching-04` | 4.5 | 44 | 9.8 | 2 | 7 | WindowsTerminal.exe, Code - Insiders.exe, msedge.exe |
| `multi-app-switching-05` | 14.5 | 26 | 1.8 | 4 | 17 | EXCEL.EXE, WindowsTerminal.exe, msedge.exe |
| `multi-app-switching-06` | 10 | 6 | 0.6 | 3 | 16 | EXCEL.EXE, WINWORD.EXE, msedge.exe |
| `multi-app-switching-07` | 8 | 22 | 2.8 | 3 | 16 | WINWORD.EXE, msedge.exe, notepad.exe |
| `office-content-01` | 9 | 5 | 0.6 | 6 | 19 | Microsoft Word (M365, C:\Program Files\Microsoft Office\root\Office16\WINWORD.EXE), Notepad++ (C:\Program Files\Notepad++\notepad++.exe), ffmpeg (D:\git\jem\vendor\ffmpeg\ffmpeg.exe) as a SEPARATE audio-only recorder on DISPLAY2 |
| `office-content-02` | 7 | 3 | 0.4 | 6 | 28 | Microsoft PowerPoint (M365, C:\Program Files\Microsoft Office\root\Office16\POWERPNT.EXE), Microsoft Edge, ffmpeg audio-only recorder on DISPLAY2 |
| `office-content-03` | 12 | 3 | 0.2 | 8 | 30 | Microsoft Excel (M365, C:\Program Files\Microsoft Office\root\Office16\EXCEL.EXE), Microsoft Edge, ffmpeg audio-only recorder on DISPLAY2 |
| `office-content-04` | 4 | 4 | 1.0 | 5 | 17 | Microsoft Edge, localhost fixture server (python -m http.server 8080 from D:\git\jams\fixtures), ffmpeg audio-only recorder on DISPLAY2 |
| `office-content-05` | 6 | 11 | 1.8 | 6 | 17 | Microsoft Edge, Snipping Tool (Microsoft.ScreenSketch), Microsoft Word (M365) |
| `office-content-06` | 8 | 14 | 1.8 | 7 | 19 | Notepad++ (C:\Program Files\Notepad++\notepad++.exe), Microsoft Word (M365, two documents open simultaneously), ffmpeg audio-only recorder on DISPLAY2 |
| `realistic-mixed-01` | 10 | 21 | 2.1 | 7 | 32 | Microsoft Edge, Visual Studio Code, File Explorer |
| `realistic-mixed-02` | 6 | 14 | 2.3 | 4 | 21 | Microsoft Edge |
| `realistic-mixed-03` | 8 | 7 | 0.9 | 6 | 22 | Windows Settings, Microsoft Edge |
| `realistic-mixed-04` | 13 | 30 | 2.3 | 7 | 33 | Visual Studio Code, Windows Terminal, Microsoft Edge |
| `realistic-mixed-05` | 9.5 | 19 | 2.0 | 6 | 25 | Windows Terminal, Visual Studio Code, Microsoft Edge |
| `realistic-mixed-06` | 7 | 12 | 1.7 | 5 | 22 | File Explorer, Paint, Notepad |
| `realistic-mixed-07` | 4 | 36 | 9.0 | 3 | 13 | Notepad, Visual Studio Code, Microsoft Edge |

**Totals:** 56 journeys, 502 min (8.4 h), 1154 narration lines (neutral 59%, positive 21%, negative 20%).
