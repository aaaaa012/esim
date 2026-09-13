import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  isCustomerNavActive,
  isExploreNavActive,
  returnToHomepageExplore,
  scrollToHomeSection,
} from "./customer-header";

describe("customer header section navigation", () => {
  const scrollIntoView = vi.fn();
  const focus = vi.fn();

  beforeEach(() => {
    document.body.innerHTML =
      '<section id="plans"></section><section id="explore" tabindex="-1"></section>';
    Object.defineProperty(document.getElementById("plans"), "scrollIntoView", {
      configurable: true,
      value: scrollIntoView,
    });
    Object.defineProperty(
      document.getElementById("explore"),
      "scrollIntoView",
      {
        configurable: true,
        value: scrollIntoView,
      },
    );
    Object.defineProperty(document.getElementById("explore"), "focus", {
      configurable: true,
      value: focus,
    });
    Object.defineProperty(window, "matchMedia", {
      configurable: true,
      value: vi.fn().mockReturnValue({ matches: false }),
    });
    window.history.replaceState(null, "", "/");
    scrollIntoView.mockClear();
    focus.mockClear();
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
    vi.mocked(window.matchMedia).mockReturnValue({
      matches: true,
    } as MediaQueryList);

    expect(scrollToHomeSection("/#plans", "/")).toBe(true);
    expect(scrollIntoView).toHaveBeenCalledWith({
      behavior: "auto",
      block: "start",
    });
  });

  it("returns to homepage discovery without changing history", () => {
    window.history.replaceState(null, "", "/#recharge");
    const historyLength = window.history.length;

    expect(returnToHomepageExplore("/")).toBe(true);
    expect(window.location.pathname).toBe("/");
    expect(window.location.hash).toBe("");
    expect(window.history.length).toBe(historyLength);
    expect(focus).toHaveBeenCalledWith({ preventScroll: true });
    expect(scrollIntoView).toHaveBeenCalledWith({
      behavior: "smooth",
      block: "start",
    });
  });

  it("jumps to homepage discovery when reduced motion is requested", () => {
    vi.mocked(window.matchMedia).mockReturnValue({
      matches: true,
    } as MediaQueryList);

    expect(returnToHomepageExplore("/")).toBe(true);
    expect(scrollIntoView).toHaveBeenCalledWith({
      behavior: "auto",
      block: "start",
    });
  });

  it("allows client navigation to home from another route", () => {
    expect(returnToHomepageExplore("/help")).toBe(false);
    expect(focus).not.toHaveBeenCalled();
    expect(scrollIntoView).not.toHaveBeenCalled();
  });
});

describe("customer header active navigation", () => {
  it("treats home and the destination catalogue as Explore", () => {
    expect(isExploreNavActive("/")).toBe(true);
    expect(isExploreNavActive("/destinations")).toBe(true);
    expect(isExploreNavActive("/destinations/australia")).toBe(true);
    expect(isExploreNavActive("/recharge")).toBe(false);
    expect(isExploreNavActive("/account/orders")).toBe(false);
    expect(isExploreNavActive("/help")).toBe(false);
  });

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
    expect(isCustomerNavActive("/destinations", "/destinations", "")).toBe(
      true,
    );
    expect(isCustomerNavActive("/recharge", "/recharge/recover", "")).toBe(
      false,
    );
    expect(
      isCustomerNavActive("/account/orders", "/recharge/recover", ""),
    ).toBe(true);
    expect(
      isCustomerNavActive("/account/orders", "/account/orders/one", ""),
    ).toBe(true);
    expect(
      isCustomerNavActive("/account/esims", "/account/esims/one", ""),
    ).toBe(true);
    expect(isCustomerNavActive("/compatibility", "/destinations", "")).toBe(
      false,
    );
  });

  it("treats compatibility as part of Help", () => {
    expect(isCustomerNavActive("/help", "/help", "")).toBe(true);
    expect(isCustomerNavActive("/help", "/compatibility", "")).toBe(true);
    expect(isCustomerNavActive("/help", "/destinations", "")).toBe(false);
  });
});
