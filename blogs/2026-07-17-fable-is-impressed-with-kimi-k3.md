# Fable is impressed with kimi-k3!

My AI chief architect doesn't impress easily. Yesterday it reviewed a design document from Moonshot's kimi-k3 and called it "genuinely impressive, frontier-tier design work." Total cost of that design: $0.38.

What earned the praise? kimi-k3 caught itself mid-reasoning. It initially chose a 320px video proxy for detecting screen changes, then ran the actual arithmetic: a browser tab switch changes about 10% of pixels at a small luma delta, which would fall below its own detection floor at that scale. So it reversed its decision and committed to 480px. It also flagged that INT8 inference kernels vary across CPU architectures, so regression tests must assert tolerances, never exact transcripts. That mistake produces tests that pass on your laptop and flake in CI, and most designs walk straight into it.

**What we're building:** my patent for AI-assisted measurement of physical effort, cognitive effort, and sentiment was recently granted, and we're turning it into a SaaS called JAMS. Upload a video of someone performing a task (a user journey) and it produces a timestamped effort and sentiment report where every finding deep-links to the exact moment in the video. Detecting context switches, transcribing narration, scoring frustration. UX research that quantifies what "this workflow is painful" actually costs.

**The delegate process:** here's the part I think is genuinely new. Claude's Fable 5 is brilliant but usage-limited. We burned 81% of a 4-hour window on planning alone, day one. So Fable doesn't type code anymore. It architects, writes specs, and reviews diffs. The typing goes to CLI agents running in full-auto on subscriptions I already pay for: GitHub Copilot CLI (running claude-sonnet-4.6), OpenAI Codex CLI (gpt-5.5), and now aider + OpenRouter for kimi-k3. Every delegate appends its own row to a scorecard in the repo with the task, model, grade, and notes. Fable consults the accumulated evidence to route the next task. Frontier reasoning where it matters, commodity typing where it doesn't.

**The scorecard so far:**

Codex/gpt-5.5 is 8-for-8 on surgical, well-specified slices. My favorite moment: unprompted, it implemented an env-var fallback for a webhook secret, and days later that exact fallback silently absorbed a naming mismatch when I configured the real keys. It also reports honestly. When Docker wasn't running, it said "blocked, here's why" instead of pretending.

Copilot/claude-sonnet-4.6 shines at big multi-file work. It scaffolded the entire monorepo in 5 logical commits, all checks green on the first try, though it once wandered into a recursive delegation loop before recovering. Its Playwright test suite caught a truncated storage key that only failed when signed URLs hit real storage.

And kimi-k3? Fable's verdict: "roughly peer-level work needing a real review rather than a rewrite." Not flawless. Fable found a real edge case (the scroll filter would suppress a legitimate cut into a scrolling page) and demoted two confident-sounding constants to "tuning guesses." But the fixture design was the standout: pure-ffmpeg synthetic test videos with programmatically known ground truth, including a real cut planted mid-scroll specifically to prove the false-positive filter doesn't eat true positives.

One model to reason, cheaper models to build, evidence to decide who does what. The future of solo development isn't one AI. It's a well-managed team of them.

(Drafted, fittingly, by Fable. Reviewed by the human.)

#AI #BuildInPublic #Claude #Kimi #GPT5 #SaaS #UXResearch #Patents
