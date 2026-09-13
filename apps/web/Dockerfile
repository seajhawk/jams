# syntax=docker/dockerfile:1
# Build from the repository root. No credentials or .env files enter this context.
FROM node:22-bookworm-slim AS build
WORKDIR /repo
ENV NEXT_TELEMETRY_DISABLED=1
RUN npm install --global pnpm@10.11.0
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/web/package.json apps/web/package.json
COPY fixtures/demo-report.v1.json fixtures/demo-report.v1.json
RUN pnpm install --frozen-lockfile
COPY apps/web apps/web
# Public Clerk configuration is compiled into browser code. Never pass secret keys.
ARG NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY
ENV NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY=$NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY
RUN test -n "$NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY" && pnpm --dir apps/web build

FROM node:22-bookworm-slim AS runtime
ENV NODE_ENV=production NEXT_TELEMETRY_DISABLED=1 HOSTNAME=0.0.0.0 PORT=3000
WORKDIR /app
COPY --from=build --chown=node:node /repo/apps/web/.next/standalone ./
COPY --from=build --chown=node:node /repo/apps/web/.next/static ./apps/web/.next/static
COPY --from=build --chown=node:node /repo/apps/web/public ./apps/web/public
USER node
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:3000/api/health/live').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "apps/web/server.js"]
