import { defineConfig, devices } from "@playwright/test";

const customerBaseUrl =
  process.env.E2E_CUSTOMER_BASE_URL ?? "http://127.0.0.1:3100";
const signedInCustomerBaseUrl =
  process.env.E2E_SIGNED_IN_CUSTOMER_BASE_URL ?? "http://127.0.0.1:3102";
const opsBaseUrl = process.env.E2E_OPS_BASE_URL ?? "http://127.0.0.1:3101";
const useManagedServers = !process.env.E2E_CUSTOMER_BASE_URL;
const publicClerkKey = process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY;
const serverClerkKey = process.env.CLERK_SECRET_KEY;
const localE2eSecret = "local-e2e-auth-secret-at-least-32-characters";
const localE2eToken = `${localE2eSecret}:SUPER_ADMIN`;
const requestedProjects = process.argv.flatMap((argument, index, argumentsList) =>
  argument === "--project"
    ? [argumentsList[index + 1] ?? ""]
    : argument.startsWith("--project=")
      ? [argument.slice("--project=".length)]
      : [],
);
const startGuestCustomer = !requestedProjects.length || requestedProjects.some(
  (project) => project.startsWith("customer-") && !project.startsWith("customer-signed-in-"),
);
const startSignedInCustomer = !requestedProjects.length || requestedProjects.some(
  (project) => project.startsWith("customer-signed-in-"),
);
const startOps = !requestedProjects.length || requestedProjects.some((project) => project.startsWith("ops-"));

export default defineConfig({
  testDir: "./tests/e2e",
  outputDir: "artifacts/playwright/results",
  fullyParallel: true,
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI ? 2 : 0,
  // Two workers keep the two managed Next.js development servers responsive
  // on modest local machines while still exercising concurrent browser use.
  workers: 2,
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
    navigationTimeout: 30_000,
  },
  projects: [
    {
      name: "api",
      testMatch: /api\/.*\.spec\.ts/,
      use: {
        baseURL: "http://127.0.0.1:4000/api/v1/",
        actionTimeout: 30_000,
      },
    },
    {
      name: "customer-desktop",
      testMatch: /customer\/.*\.spec\.ts/,
      use: {
        ...devices["Desktop Chrome"],
        baseURL: customerBaseUrl,
      },
    },
    {
      name: "customer-laptop",
      testMatch: /customer\/.*\.spec\.ts/,
      use: {
        browserName: "chromium",
        viewport: { width: 1024, height: 768 },
        baseURL: customerBaseUrl,
      },
    },
    {
      name: "customer-wide-monitor",
      testMatch: /customer\/.*\.spec\.ts/,
      use: {
        browserName: "chromium",
        viewport: { width: 1920, height: 1080 },
        baseURL: customerBaseUrl,
      },
    },
    {
      name: "customer-mobile",
      testMatch: /customer\/.*\.spec\.ts/,
      use: {
        ...devices["iPhone 13"],
        browserName: "chromium",
        baseURL: customerBaseUrl,
      },
    },
    {
      name: "customer-signed-in-desktop",
      testMatch: /customer\/signed-in-hosted-resume\.spec\.ts/,
      use: { ...devices["Desktop Chrome"], baseURL: signedInCustomerBaseUrl },
    },
    {
      name: "customer-signed-in-mobile",
      testMatch: /customer\/signed-in-hosted-resume\.spec\.ts/,
      use: { ...devices["iPhone 13"], browserName: "chromium", baseURL: signedInCustomerBaseUrl },
    },
    {
      name: "customer-small-mobile",
      testMatch: /customer\/.*\.spec\.ts/,
      use: {
        browserName: "chromium",
        viewport: { width: 320, height: 568 },
        baseURL: customerBaseUrl,
      },
    },
    {
      name: "customer-tablet",
      testMatch: /customer\/.*\.spec\.ts/,
      use: {
        browserName: "chromium",
        viewport: { width: 768, height: 1024 },
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
      name: "ops-laptop",
      testMatch: /ops\/.*\.spec\.ts/,
      use: {
        browserName: "chromium",
        viewport: { width: 1024, height: 768 },
        baseURL: opsBaseUrl,
      },
    },
    {
      name: "ops-wide-monitor",
      testMatch: /ops\/.*\.spec\.ts/,
      use: {
        browserName: "chromium",
        viewport: { width: 1920, height: 1080 },
        baseURL: opsBaseUrl,
      },
    },
    {
      name: "ops-mobile",
      testMatch: /ops\/.*\.spec\.ts/,
      use: {
        ...devices["iPhone 13"],
        browserName: "chromium",
        baseURL: opsBaseUrl,
      },
    },
    {
      name: "ops-small-mobile",
      testMatch: /ops\/.*\.spec\.ts/,
      use: {
        browserName: "chromium",
        viewport: { width: 320, height: 568 },
        baseURL: opsBaseUrl,
      },
    },
    {
      name: "ops-tablet",
      testMatch: /ops\/.*\.spec\.ts/,
      use: {
        browserName: "chromium",
        viewport: { width: 768, height: 1024 },
        baseURL: opsBaseUrl,
      },
    },
  ],
  webServer: useManagedServers
    ? [
        {
          command: "./node_modules/.bin/nest start",
          cwd: "./apps/api",
          // The managed E2E API intentionally runs without PostgreSQL/Redis.
          // Wait for the process liveness endpoint; deployed-environment suites
          // still exercise /health/ready against their real dependencies.
          url: "http://127.0.0.1:4000/api/v1/health/live",
          reuseExistingServer: false,
          timeout: 120_000,
          env: {
            NODE_ENV: "test",
            PORT: "4000",
            PERSISTENCE_MODE: "memory",
            ORDER_WORKFLOW_MODE: "single-instance",
            PAYMENT_MODE: "simulator",
            PAYMENT_SIMULATOR_SECRET: "local-payment-simulator-secret-32-chars",
            CONNECTIVITY_PROVIDER: "auriga-mock",
            NOTIFICATION_MODE: "simulator",
            E2E_AUTH_ENABLED: "true",
            E2E_AUTH_SECRET: localE2eSecret,
            GUEST_ORDER_SECRET: "local-guest-order-secret-at-least-32-chars",
            PII_HASH_KEY: "local-pii-hash-secret-at-least-32-characters",
            APP_ENCRYPTION_KEY_BASE64:
              "MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWY=",
            CUSTOMER_WEB_URL: customerBaseUrl,
            OPS_WEB_URL: opsBaseUrl,
            API_PUBLIC_URL: "http://127.0.0.1:4000",
          },
        },
        ...(startGuestCustomer ? [{
          command: "./node_modules/.bin/next dev -p 3100",
          cwd: "./apps/customer-web",
          url: customerBaseUrl,
          reuseExistingServer: !process.env.CI,
          timeout: 120_000,
          env: {
            NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY:
              publicClerkKey ?? "pk_test_Y2xlcmsuZXhhbXBsZS5jb20k",
            CLERK_SECRET_KEY: serverClerkKey ?? "local-e2e-clerk-disabled",
            NEXT_PUBLIC_API_URL: "http://127.0.0.1:4000/api/v1",
            NEXT_PUBLIC_PAYMENT_MODE: "simulator",
            NEXT_PUBLIC_E2E_TEST_MODE: "true",
            NEXT_PUBLIC_E2E_SIGNED_IN: "false",
            NEXT_PUBLIC_E2E_AUTH_TOKEN: localE2eToken,
          },
        }] : []),
        ...(startSignedInCustomer ? [{
          command: "./node_modules/.bin/next dev -p 3102",
          cwd: "./apps/customer-web",
          url: signedInCustomerBaseUrl,
          reuseExistingServer: !process.env.CI,
          timeout: 120_000,
          env: {
            NEXT_DIST_DIR: ".next-e2e-signed-in",
            NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY:
              publicClerkKey ?? "pk_test_Y2xlcmsuZXhhbXBsZS5jb20k",
            CLERK_SECRET_KEY: serverClerkKey ?? "local-e2e-clerk-disabled",
            NEXT_PUBLIC_API_URL: "http://127.0.0.1:4000/api/v1",
            NEXT_PUBLIC_PAYMENT_MODE: "simulator",
            NEXT_PUBLIC_E2E_TEST_MODE: "true",
            NEXT_PUBLIC_E2E_SIGNED_IN: "true",
            NEXT_PUBLIC_E2E_AUTH_TOKEN: localE2eToken,
          },
        }] : []),
        ...(startOps ? [{
          command: "./node_modules/.bin/next dev -p 3101",
          cwd: "./apps/ops-web",
          url: opsBaseUrl,
          reuseExistingServer: !process.env.CI,
          timeout: 120_000,
          env: {
            NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY:
              publicClerkKey ?? "pk_test_Y2xlcmsuZXhhbXBsZS5jb20k",
            CLERK_SECRET_KEY: serverClerkKey ?? "local-e2e-clerk-disabled",
            NEXT_PUBLIC_API_URL: "http://127.0.0.1:4000/api/v1",
            NEXT_PUBLIC_E2E_TEST_MODE: "true",
            NEXT_PUBLIC_E2E_SIGNED_IN: "true",
            NEXT_PUBLIC_E2E_AUTH_TOKEN: localE2eToken,
          },
        }] : []),
      ]
    : undefined,
});
