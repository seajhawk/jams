# Vally agent evaluations

These Vally specs evaluate an agent's repository-work behavior. They do not
benchmark JAMS video, audio, or scoring providers; those use the deterministic
JEM and fixture harness described in `docs/EVALUATION-MATRIX.md`.

Run static validation, which makes no model calls:

```powershell
pnpm eval:lint
```

Run the guardrail suite manually with an explicit model and an isolated Vally
workspace. This is deliberately not a CI command because it executes an agent:

```powershell
pnpm eval:agent -- --model <model> --workspace C:\Temp\jams-vally-workspaces
```

The default Vally executor is `copilot-sdk`; it uses the active GitHub Copilot
authentication. To compare a local or hosted model, pass Vally a model and an
explicit provider configuration appropriate to that environment. Do not put
credentials in an eval spec. Vally's `executor.config.provider` supports an
OpenAI-compatible endpoint such as Ollama, vLLM, Azure AI Foundry, or OpenAI.
Results are ignored at `.vally-results/`.
