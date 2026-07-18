# CV Fixture Generator

This package records deterministic browser fixtures for the worker golden tests.

Keep `playwright` exactly aligned with the locked `@playwright/test` version in
`apps/web`. The generator intentionally reuses the repo-wide cached Playwright
Chromium build; do not install or pin a separate browser for this package.

```powershell
pnpm install --ignore-workspace
pnpm fixtures --output-dir ../../tests/fixtures/generated
```
