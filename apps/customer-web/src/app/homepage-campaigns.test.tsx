import {
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { beforeAll, describe, expect, it, vi } from "vitest";
import {
  CampaignProvider,
  FeaturedCampaign,
  GuideCampaign,
  OfferGallery,
  WhyCampaign,
} from "./homepage-campaigns";

vi.mock("next/image", () => ({
  default: ({
    priority: _priority,
    ...props
  }: React.ImgHTMLAttributes<HTMLImageElement> & { priority?: boolean }) => (
    // eslint-disable-next-line @next/next/no-img-element
    <img {...props} />
  ),
}));
vi.mock("next/link", () => ({
  default: ({
    href,
    children,
    ...props
  }: React.AnchorHTMLAttributes<HTMLAnchorElement> & { href: string }) => (
    <a href={href} {...props}>
      {children}
    </a>
  ),
}));

beforeAll(() => {
  HTMLDialogElement.prototype.showModal = function showModal() {
    this.setAttribute("open", "");
  };
  HTMLDialogElement.prototype.close = function close() {
    this.removeAttribute("open");
    this.dispatchEvent(new Event("close"));
  };
});

describe("homepage campaigns", () => {
  it("keeps all seeded placements available when the API is unavailable", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementationOnce(
      () => new Promise(() => undefined),
    );
    render(
      <CampaignProvider>
        <FeaturedCampaign />
        <OfferGallery />
        <GuideCampaign />
        <WhyCampaign />
      </CampaignProvider>,
    );

    expect(
      screen.getByRole("heading", { name: /travel connected/i }),
    ).toBeTruthy();
    expect(screen.getByRole("heading", { name: /choose where/i })).toBeTruthy();
    expect(
      screen.getByRole("button", { name: /view full poster: Australia/i }),
    ).toBeTruthy();
    expect(
      screen.getByRole("button", { name: /view full setup guide/i }),
    ).toBeTruthy();
  });

  it("opens a labelled full-size viewer and provides the matching country CTA", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementationOnce(
      () => new Promise(() => undefined),
    );
    render(
      <CampaignProvider>
        <OfferGallery />
      </CampaignProvider>,
    );

    fireEvent.click(
      screen.getByRole("button", { name: /view full poster: Australia/i }),
    );
    await waitFor(() =>
      expect(screen.getByRole("dialog").hasAttribute("open")).toBe(true),
    );
    const dialog = screen.getByRole("dialog");
    expect(
      within(dialog).getByRole("heading", {
        name: "Australia travel eSIM offer",
      }),
    ).toBeTruthy();
    expect(
      within(dialog)
        .getByRole("link", { name: /view plans/i })
        .getAttribute("href"),
    ).toBe("/?country=AU#plans");

    fireEvent.click(
      screen.getByRole("button", { name: "Close poster viewer" }),
    );
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  });
});
