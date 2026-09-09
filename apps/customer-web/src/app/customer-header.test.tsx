import { beforeEach, describe, expect, it, vi } from "vitest";
import { isCustomerNavActive, scrollToHomeSection } from "./customer-header";

describe("customer header section navigation", () => {
  const scrollIntoView = vi.fn();

  beforeEach(() => {
    document.body.innerHTML = '<section id="plans"></section>';
    Object.defineProperty(document.getElementById("plans"), "scrollIntoView", {
      configurable: true,
      value: scrollIntoView,
    });
    Object.defineProperty(window, "matchMedia", {
      configurable: true,
      value: vi.fn().mockReturnValue({ matches: false }),
    });
    window.history.replaceState(null, "", "/");
    scrollIntoView.mockClear();
  });

  it("scrolls to the destination section from the homepage", () => {
    expect(scrollToHomeSection("/#plans", "/")).toBe(true);
    expect(window.location.hash).toBe("#plans");
    expect(scrollIntoView).toHaveBeenCalledWith({
      behavior: "smooth",
      block: "start",
    });
  });

  it("scrolls again when the destination hash is already active", () => {
    window.history.replaceState(null, "", "/#plans");

    expect(scrollToHomeSection("/#plans", "/")).toBe(true);
    expect(scrollIntoView).toHaveBeenCalledOnce();
  });

  it("allows normal routing when navigating from another page", () => {
    expect(scrollToHomeSection("/#plans", "/compatibility")).toBe(false);
    expect(scrollIntoView).not.toHaveBeenCalled();
  });

  it("does not animate section navigation when reduced motion is requested", () => {
    vi.mocked(window.matchMedia).mockReturnValue({ matches: true } as MediaQueryList);

    expect(scrollToHomeSection("/#plans", "/")).toBe(true);
    expect(scrollIntoView).toHaveBeenCalledWith({
      behavior: "auto",
      block: "start",
    });
  });
});

describe("customer header active navigation", () => {
  it("highlights Home only for the homepage without a section hash", () => {
    expect(isCustomerNavActive("/", "/", "")).toBe(true);
    expect(isCustomerNavActive("/", "/", "#recharge")).toBe(false);
    expect(isCustomerNavActive("/", "/destinations", "")).toBe(false);
  });

  it("highlights only the matching homepage section", () => {
    expect(isCustomerNavActive("/#recharge", "/", "#recharge")).toBe(true);
    expect(isCustomerNavActive("/#how", "/", "#recharge")).toBe(false);
  });

  it("matches standalone routes and their child pages", () => {
    expect(isCustomerNavActive("/destinations", "/destinations", "")).toBe(true);
    expect(isCustomerNavActive("/account/esims", "/account/esims/one", "")).toBe(true);
    expect(isCustomerNavActive("/compatibility", "/destinations", "")).toBe(false);
  });
});
