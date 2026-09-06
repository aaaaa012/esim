import { expect, type Page, type TestInfo } from "@playwright/test";

export type BrowserProblem = {
  kind: "console" | "pageerror" | "requestfailed";
  detail: string;
};

export function observeBrowserProblems(page: Page) {
  const problems: BrowserProblem[] = [];
  page.on("console", (message) => {
    if (message.type() === "error")
      problems.push({ kind: "console", detail: message.text() });
  });
  page.on("pageerror", (error) => {
    problems.push({ kind: "pageerror", detail: error.message });
  });
  page.on("requestfailed", (request) => {
    const url = request.url();
    if (!url.includes("clerk") && !url.includes("accounts.dev")) {
      problems.push({
        kind: "requestfailed",
        detail: `${request.method()} ${url}: ${request.failure()?.errorText ?? "failed"}`,
      });
    }
  });
  return problems;
}

export async function expectNoHorizontalOverflow(page: Page) {
  const dimensions = await page.evaluate(() => ({
    viewport: document.documentElement.clientWidth,
    document: document.documentElement.scrollWidth,
  }));
  expect(dimensions.document, JSON.stringify(dimensions)).toBeLessThanOrEqual(
    dimensions.viewport + 1,
  );
}

export async function auditInteractiveNames(page: Page) {
  const unnamed = await page
    .locator("button, a[href], input, select, textarea")
    .evaluateAll((elements) =>
      elements.flatMap((element, index) => {
        const html = element as HTMLElement;
        const text = html.innerText?.trim();
        const aria = element.getAttribute("aria-label")?.trim();
        const labelledBy = element.getAttribute("aria-labelledby")?.trim();
        const title = element.getAttribute("title")?.trim();
        const input = element as HTMLInputElement;
        const label = input.id
          ? document.querySelector(`label[for="${CSS.escape(input.id)}"]`)
          : null;
        return text || aria || labelledBy || title || label
          ? []
          : [`${element.tagName.toLowerCase()}[${index}] ${element.outerHTML.slice(0, 180)}`];
      }),
    );
  expect(unnamed, unnamed.join("\n")).toEqual([]);
}

export async function attachAudit(
  testInfo: TestInfo,
  name: string,
  value: unknown,
) {
  await testInfo.attach(name, {
    body: Buffer.from(JSON.stringify(value, null, 2)),
    contentType: "application/json",
  });
}
