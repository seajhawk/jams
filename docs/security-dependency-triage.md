# Production Dependency Audit & Security Triage

## Overview

This document tracks the dependency maintenance review and vulnerability triage for JAMS (`apps/web`). As part of the dependency-maintenance P1 review, production dependencies were audited, scaffold-only tooling was moved out of production scope, and Next.js was upgraded to a maintained patched release.

### Summary Metrics

- **Audit Command:** `pnpm audit --prod --json` (run from `apps/web`)
- **Initial State:** 46 production vulnerabilities (0 critical, 23 high, 22 moderate, 1 low) across 761 production packages.
  - Next.js core App Router/Server Actions vulnerabilities: 9
  - Scaffold tooling (`shadcn` CLI) in production dependencies: 25
  - Indirect dependencies: 12
- **Remediated Actions:**
  - Upgraded `next` from `16.2.10` to `16.2.12` (maintained patched release >= `16.2.11`).
  - Upgraded `eslint-config-next` from `16.2.10` to `16.2.12` to match Next.js framework release.
  - Moved `shadcn` (`^4.13.0`) CLI tool from `dependencies` to `devDependencies` (build/scaffold-only utility).
  - Preserved strict lockfile integrity (surgical diff, 56 insertions / 56 deletions in `pnpm-lock.yaml`).
- **Post-Remediation State:** 12 production vulnerabilities (0 critical, 8 high, 4 moderate, 0 low) across 553 production packages.
  - 34 vulnerabilities resolved (-74% reduction).
  - All 9 direct Next.js core App Router/Turbopack/Server Actions vulnerabilities eliminated.
  - All 25 transitive vulnerabilities from scaffold CLI eliminated from production deploy graph.
- **Verification:**
  - `pnpm test` (unit test suite): 19/19 files passed (85 tests passed, 0 failed).
  - `pnpm lint`: clean (0 errors, 0 warnings).
  - `pnpm build`: Next.js 16.2.12 production compilation and static page generation succeeded.

---

## Triage of Remaining Advisories

The 12 remaining advisories exist exclusively in indirect transitive dependencies pinned by framework/SDK packages (`next` and `@clerk/ui`). None are reachable under JAMS runtime configuration.

### 1. PostCSS & NanoID (Transitive via `next`)

| Field | Detail |
| :--- | :--- |
| **Modules** | `postcss` (GHSA-qx2v-qp2m-jg93 / CVE-2026-41305, GHSA-6g55-p6wh-862q / CVE-2026-45623, GHSA-fxqj-rqcc-2cmp / CVE-2026-69153, GHSA-r28c-9q8g-f849 / CVE-2026-73646), `nanoid` (GHSA-2v37-7h3g-55p8 / CVE-2026-67213) |
| **Path** | `. > next > postcss` (8.4.31) and `. > next > postcss > nanoid` (3.3.16) |
| **Severity** | 3 High, 2 Moderate |
| **Reachability** | **Unreachable at Runtime.** PostCSS and its internal `nanoid` utility are used strictly during build time (`next build`) by Next.js to transform static CSS stylesheets. JAMS does not accept, parse, or evaluate user-supplied CSS, custom CSS source maps, or dynamic stylesheets at runtime. In the production Node.js server (`next start`), PostCSS is not invoked. |
| **Mitigation** | Pinned internally by Next.js 16.2.x engine. Upstream patch tracking will incorporate newer PostCSS and NanoID releases in Next.js minor updates. Static CSS input in JAMS is authored and vetted in-repo only. |
| **Owner** | Web Platform Team |

### 2. Sharp / libvips (Transitive via `next`)

| Field | Detail |
| :--- | :--- |
| **Module** | `sharp` (GHSA-f88m-g3jw-g9cj) |
| **Path** | `. > next > sharp` (0.34.5, optional dependency of `next`) |
| **Severity** | High |
| **Reachability** | **Unreachable at Runtime.** Next.js includes `sharp` as an optional dependency for its built-in Image Optimization API (`next/image`). JAMS does not import or use `next/image` anywhere in the application, does not configure remote image optimization patterns, and explicitly lists `sharp` in `ignoredBuiltDependencies`. No image processing endpoints are exposed to user input. |
| **Mitigation** | Image optimization pipeline is unused. Native builds of sharp are suppressed in package workspace configuration. |
| **Owner** | Web Platform Team |

### 3. Solana Web3 / Jayson Stack (Transitive via `@clerk/ui`)

| Field | Detail |
| :--- | :--- |
| **Modules** | `uuid` (GHSA-w5hq-g745-h8pq / CVE-2026-41907), `stream-json` (GHSA-528h-pc64-c93x / CVE-2026-71429) |
| **Path** | `. > @clerk/ui > @solana/wallet-adapter-base > @solana/web3.js > jayson > [uuid (8.3.2), stream-json (1.9.1)]` |
| **Severity** | 2 Moderate |
| **Reachability** | **Unreachable at Runtime.** `@clerk/ui` is present in the workspace package manifest but is not imported anywhere in JAMS application code (authentication is handled purely via `@clerk/nextjs`). Furthermore, JAMS does not enable Web3 or Solana wallet authentication, meaning `@solana/web3.js` and its JSON-RPC client (`jayson`) are never instantiated or executed. |
| **Mitigation** | Solana wallet integrations are inactive and unreferenced. Upstream Clerk releases are tracked for improved tree-shaking and decoupling of optional wallet adapters. |
| **Owner** | Auth & Identity Team |

### 4. React Native Mobile Toolchain (Transitive via `@clerk/ui`)

| Field | Detail |
| :--- | :--- |
| **Modules** | `image-size` (GHSA-w3rx-r6r6-pgpr / CVE-2025-71330, GHSA-5p2g-fcmc-qvqq / CVE-2025-71329), `browserslist` (GHSA-c83g-rgw3-j3cx / CVE-2026-73089, GHSA-73wf-gq98-2v4g / CVE-2026-73088) |
| **Path** | `. > @clerk/ui > @solana/wallet-adapter-react > @solana-mobile/wallet-adapter-mobile > react-native > ... > [image-size (1.2.1), browserslist (4.28.6)]` |
| **Severity** | 4 High |
| **Reachability** | **Unreachable at Runtime.** These packages are part of the React Native mobile build toolchain (`metro` packager CLI and `@react-native/codegen` Babel transform) pulled into `@clerk/ui`'s multi-target package manifest. They are mobile-only build tools and are never executed in the Node.js production server or browser bundle. |
| **Mitigation** | React Native build CLI is inert in web/server environments. Unreachable by HTTP requests or runtime execution. |
| **Owner** | Auth & Identity Team |

---

## Action Items & Tracking

1. **Next.js Upstream:** Monitor upcoming Next.js releases (16.3+) to evaluate upstream bumps to `postcss` (>=8.5.23) and `sharp` (>=0.35.0) when proven stable with the turbopack compiler.
2. **Clerk Upstream:** Coordinate with Clerk updates to evaluate standalone modular `@clerk/ui` packaging that does not bundle transitive mobile and Solana wallet adapter trees into web distributions.
