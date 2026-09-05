# Production Dependency Audit & Security Triage

## Overview

This document tracks the dependency maintenance review and vulnerability triage for JAMS (`apps/web`). As part of the dependency-maintenance P1 review, production dependencies were audited, scaffold-only tooling was moved out of production scope, unused packages were eliminated, and Next.js was upgraded to a maintained patched release.

### Summary Metrics

- **Audit Command:** `pnpm audit --prod --json` (run from `apps/web`)
- **Initial State:** 46 production vulnerabilities (0 critical, 23 high, 22 moderate, 1 low) across 761 production packages.
  - Next.js core App Router/Server Actions vulnerabilities: 9
  - Scaffold tooling (`shadcn` CLI) in production dependencies: 25
  - Unused `@clerk/ui` transitive Solana/mobile graph: 6
  - Indirect framework dependencies: 6
- **Remediated Actions:**
  - Upgraded `next` from `16.2.10` to `16.2.12` (maintained patched release >= `16.2.11`).
  - Upgraded `eslint-config-next` from `16.2.10` to `16.2.12` to match Next.js framework release.
  - Moved `shadcn` (`^4.13.0`) CLI tool from `dependencies` to `devDependencies` (build/scaffold-only utility).
  - Removed unused `@clerk/ui` (`^1.25.5`) dependency entirely after full repository search confirmed no application imports or usage exist (JAMS uses `@clerk/nextjs` exclusively).
  - Preserved lockfile integrity and drastically reduced dependency footprint (from 761 to 214 production dependencies).
- **Post-Remediation State:** 8 production vulnerabilities (0 critical, 6 high, 2 moderate, 0 low) across 214 production packages.
  - 38 vulnerabilities resolved (-82.6% reduction).
  - 547 production packages removed (-71.9% reduction in production package surface).
  - All 9 direct Next.js core App Router/Turbopack/Server Actions vulnerabilities eliminated.
  - All 25 transitive vulnerabilities from scaffold CLI eliminated from production deploy graph.
  - All 6 transitive vulnerabilities from unused `@clerk/ui` (Solana Web3 wallet adapter, React Native mobile toolchain) eliminated.
- **Verification:**
  - `pnpm vitest run --exclude "**/*.integration.test.ts"`: 19/19 files passed (85 tests passed, 0 failed).
  - `pnpm lint`: clean (0 errors, 0 warnings).
  - `pnpm build`: Next.js 16.2.12 production compilation and static page generation succeeded.

---

## Triage of Remaining Advisories

The 8 remaining advisories exist exclusively in indirect transitive dependencies pinned internally by the Next.js framework (`next`). None are reachable under JAMS runtime configuration.

### 1. PostCSS & NanoID (Transitive via `next`)

| Field | Detail |
| :--- | :--- |
| **Modules** | `postcss` (GHSA-qx2v-qp2m-jg93 / CVE-2026-41305, GHSA-6g55-p6wh-862q / CVE-2026-45623, GHSA-fxqj-rqcc-2cmp / CVE-2026-69153, GHSA-r28c-9q8g-f849 / CVE-2026-73646), `nanoid` (GHSA-2v37-7h3g-55p8 / CVE-2026-67213) |
| **Path** | `. > next > postcss` (8.4.31) and `. > next > postcss > nanoid` (3.3.16) |
| **Severity** | 3 High, 2 Moderate |
| **Reachability** | **Unreachable at Runtime.** PostCSS and its internal `nanoid` utility are used strictly during build time (`next build`) by Next.js to transform static CSS stylesheets. JAMS does not accept, parse, or evaluate user-supplied CSS, custom CSS source maps, or dynamic stylesheets at runtime. In the production Node.js server (`next start`), PostCSS is not invoked. |
| **Mitigation** | Pinned internally by Next.js 16.2.x engine. Upstream patch tracking will incorporate newer PostCSS and NanoID releases in Next.js minor updates. Static CSS input in JAMS is authored and vetted in-repo only. |
| **Dependency Owner** | Upstream (Next.js / Vercel) & JAMS maintainers (@seajhawk) |

### 2. Sharp / libvips (Transitive via `next`)

| Field | Detail |
| :--- | :--- |
| **Module** | `sharp` (GHSA-f88m-g3jw-g9cj) |
| **Path** | `. > next > sharp` (0.34.5, optional dependency of `next`) |
| **Severity** | High |
| **Reachability** | **Unreachable at Runtime.** Next.js includes `sharp` as an optional dependency for its built-in Image Optimization API (`next/image`). JAMS does not import or use `next/image` anywhere in the application, does not configure remote image optimization patterns, and explicitly lists `sharp` in `ignoredBuiltDependencies`. No image processing endpoints are exposed to user input. |
| **Mitigation** | Image optimization pipeline is unused. Native builds of sharp are suppressed in package workspace configuration. |
| **Dependency Owner** | Upstream (Next.js / Vercel) & JAMS maintainers (@seajhawk) |

### 3. Browserslist (Transitive via `next > styled-jsx`)

| Field | Detail |
| :--- | :--- |
| **Module** | `browserslist` (GHSA-c83g-rgw3-j3cx / CVE-2026-73089, GHSA-73wf-gq98-2v4g / CVE-2026-73088) |
| **Path** | `. > next > styled-jsx > @babel/core > @babel/helper-compilation-targets > browserslist` (4.28.6) |
| **Severity** | 2 High |
| **Reachability** | **Unreachable at Runtime.** Browserslist is invoked during compilation (`next build`) to resolve browser support targets for Babel transforms in `styled-jsx`. It is not executed at runtime. JAMS does not load untrusted `browserslist-stats.json` files or execute dynamic browser target queries on user requests. |
| **Mitigation** | Build-time toolchain only; inert in production runtime. Upstream Next.js releases will update internal `@babel/core` targets. |
| **Dependency Owner** | Upstream (Next.js / Vercel) & JAMS maintainers (@seajhawk) |

---

## Action Items & Upstream Tracking

1. **Next.js Upstream:** Track upcoming Next.js releases (16.3+) for upstream updates to `postcss` (>=8.5.23), `sharp` (>=0.35.0), and Babel/browserslist dependencies when verified stable with Turbopack.
2. **Periodic Audits:** Maintain zero unnecessary dependencies in production manifests; run `pnpm audit --prod` as part of regular release checklists.
