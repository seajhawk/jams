import { defineConfig, devices } from "@playwright/test"

const baseURL = process.env.PLAYWRIGHT_BASE_URL ?? "http://localhost:3000"

const localEnv = {
  ...process.env,
  DATABASE_URL:
    process.env.DATABASE_URL ?? "postgresql://jams:jams@localhost:5432/jams",
  DATABASE_URL_WEB:
    process.env.DATABASE_URL_WEB ??
    "postgresql://jams_web:jams_web@localhost:5432/jams",
  AZURE_STORAGE_CONNECTION_STRING:
    process.env.AZURE_STORAGE_CONNECTION_STRING ??
    "DefaultEndpointsProtocol=http;AccountName=devstoreaccount1;AccountKey=Eby8vdM02xNOcqFlqUwJPLlmEtlCDXJ1OUzFT50uSRZ6IFsuFq2UVErCz4I6tq/K1SZFPTOtr/KBHBeksoGMGw==;BlobEndpoint=http://localhost:10000/devstoreaccount1;QueueEndpoint=http://localhost:10001/devstoreaccount1;TableEndpoint=http://localhost:10002/devstoreaccount1;",
}

export default defineConfig({
  testDir: "./e2e",
  fullyParallel: false,
  reporter: [["list"]],
  globalSetup: "./e2e/global.setup.ts",
  use: {
    baseURL,
    trace: "retain-on-failure",
    video: "retain-on-failure",
  },
  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"] },
    },
  ],
  webServer: {
    command: `pnpm dev --port ${new URL(baseURL).port || "3000"}`,
    env: localEnv,
    reuseExistingServer: !process.env.CI && process.env.JAMS_RUN_PIPELINE_E2E !== "1",
    timeout: 120_000,
    url: baseURL,
  },
})
