import { defineConfig, devices } from "@playwright/test";

const customerBaseUrl =
  process.env.E2E_CUSTOMER_BASE_URL ?? "http://127.0.0.1:3100";
const opsBaseUrl = process.env.E2E_OPS_BASE_URL ?? "http://127.0.0.1:3101";
const useManagedServers = !process.env.E2E_CUSTOMER_BASE_URL;
const publicClerkKey = process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY;
const serverClerkKey = process.env.CLERK_SECRET_KEY;

if (useManagedServers && (!publicClerkKey || !serverClerkKey)) {
  throw new Error(
    "Local E2E requires NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY and CLERK_SECRET_KEY from a Clerk test instance. Alternatively set E2E_CUSTOMER_BASE_URL and E2E_OPS_BASE_URL to an already deployed test environment.",
  );
}

export default defineConfig({
  testDir: "./tests/e2e",
  outputDir: "artifacts/playwright/results",
  fullyParallel: true,
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI ? 2 : 0,
  workers: process.env.CI ? 2 : undefined,
  timeout: 45_000,
  expect: { timeout: 10_000 },
  reporter: [
    ["line"],
    ["html", { outputFolder: "artifacts/playwright/html", open: "never" }],
    ["junit", { outputFile: "artifacts/playwright/junit.xml" }],
    ["json", { outputFile: "artifacts/playwright/results.json" }],
  ],
  use: {
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    video: "retain-on-failure",
    actionTimeout: 10_000,
    navigationTimeout: 20_000,
  },
  projects: [
    {
      name: "customer-desktop",
      testMatch: /customer\/.*\.spec\.ts/,
      use: {
        ...devices["Desktop Chrome"],
        baseURL: customerBaseUrl,
      },
    },
    {
      name: "customer-mobile",
      testMatch: /customer\/.*\.spec\.ts/,
      use: {
        ...devices["iPhone 13"],
        baseURL: customerBaseUrl,
      },
    },
    {
      name: "ops-desktop",
      testMatch: /ops\/.*\.spec\.ts/,
      use: {
        ...devices["Desktop Chrome"],
        baseURL: opsBaseUrl,
      },
    },
    {
      name: "ops-mobile",
      testMatch: /ops\/.*\.spec\.ts/,
      use: {
        ...devices["iPhone 13"],
        baseURL: opsBaseUrl,
      },
    },
  ],
  webServer: useManagedServers
    ? [
        {
          command:
            "pnpm --filter @visa-compass/customer-web exec next dev -p 3100",
          url: customerBaseUrl,
          reuseExistingServer: !process.env.CI,
          timeout: 120_000,
          env: {
            NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY: publicClerkKey!,
            CLERK_SECRET_KEY: serverClerkKey!,
            NEXT_PUBLIC_API_URL: "http://127.0.0.1:4000/api/v1",
            NEXT_PUBLIC_PAYMENT_MODE: "simulator",
          },
        },
        {
          command: "pnpm --filter @visa-compass/ops-web exec next dev -p 3101",
          url: opsBaseUrl,
          reuseExistingServer: !process.env.CI,
          timeout: 120_000,
          env: {
            NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY: publicClerkKey!,
            CLERK_SECRET_KEY: serverClerkKey!,
            NEXT_PUBLIC_API_URL: "http://127.0.0.1:4000/api/v1",
          },
        },
      ]
    : undefined,
});
