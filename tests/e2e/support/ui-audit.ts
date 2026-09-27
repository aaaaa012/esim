import { expect, type Page, type TestInfo } from "@playwright/test";

export type BrowserProblem = {
  kind: "console" | "pageerror" | "requestfailed" | "http";
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
  page.on("response", (response) => {
    if (response.status() >= 500 && response.url().includes("/api/")) {
      problems.push({
        kind: "http",
        detail: `${response.request().method()} ${response.url()}: HTTP ${response.status()}`,
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

export async function expectElementsInsideViewport(
  page: Page,
  selector: string,
) {
  const violations = await page.locator(selector).evaluateAll((elements) => {
    const viewportWidth = document.documentElement.clientWidth;
    return elements.flatMap((element) => {
      const html = element as HTMLElement;
      const style = getComputedStyle(html);
      if (style.display === "none" || style.visibility === "hidden") return [];
      const rect = html.getBoundingClientRect();
      const innerOverflow = html.scrollWidth > html.clientWidth + 1;
      const outsideViewport = rect.left < -1 || rect.right > viewportWidth + 1;
      return innerOverflow || outsideViewport
        ? [
            {
              element: html.outerHTML.slice(0, 180),
              left: Math.round(rect.left),
              right: Math.round(rect.right),
              clientWidth: html.clientWidth,
              scrollWidth: html.scrollWidth,
              viewportWidth,
            },
          ]
        : [];
    });
  });
  expect(violations, JSON.stringify(violations, null, 2)).toEqual([]);
}

export async function expectNoCollapsedText(page: Page) {
  const violations = await page
    .locator(
      "main button, main a[href], main p, main h1, main h2, main h3, main h4, main [role='status'], main [role='note']",
    )
    .evaluateAll((elements) =>
      elements.flatMap((element) => {
        const html = element as HTMLElement;
        const style = getComputedStyle(html);
        const text = (html.innerText || html.textContent || "")
          .replace(/\s+/g, " ")
          .trim();
        const rect = html.getBoundingClientRect();
        const lineHeight = Number.parseFloat(style.lineHeight);
        if (
          !text ||
          text.length < 16 ||
          style.display === "none" ||
          style.visibility === "hidden" ||
          rect.width >= 64 ||
          !Number.isFinite(lineHeight) ||
          rect.height / lineHeight < 4
        )
          return [];
        return [
          {
            element: html.outerHTML.slice(0, 180),
            text: text.slice(0, 100),
            width: Math.round(rect.width),
            lines: Math.round(rect.height / lineHeight),
          },
        ];
      }),
    );
  expect(violations, JSON.stringify(violations, null, 2)).toEqual([]);
}

export async function auditInteractiveNames(page: Page) {
  const unnamed = await page
    .locator("button, a[href], input, select, textarea")
    .evaluateAll((elements) =>
      elements.flatMap((element, index) => {
        const html = element as HTMLElement;
        if (
          element.getAttribute("aria-hidden") === "true" ||
          (element instanceof HTMLInputElement && element.type === "hidden") ||
          html.hidden ||
          getComputedStyle(html).display === "none"
        )
          return [];
        const text = (html.innerText || html.textContent)?.trim();
        const aria = element.getAttribute("aria-label")?.trim();
        const labelledBy = element.getAttribute("aria-labelledby")?.trim();
        const title = element.getAttribute("title")?.trim();
        const input = element as HTMLInputElement;
        const label = input.id
          ? document.querySelector(`label[for="${CSS.escape(input.id)}"]`)
          : null;
        const wrappingLabel = element.closest("label")?.textContent?.trim();
        return text || aria || labelledBy || title || label || wrappingLabel
          ? []
          : [
              `${element.tagName.toLowerCase()}[${index}] ${element.outerHTML.slice(0, 180)}`,
            ];
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
