import { beforeEach, describe, expect, it, vi } from "vitest";
import { scrollToHomeSection } from "./customer-header";

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
