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
  resolveCampaignImageUrl,
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
  it("resolves API-hosted artwork without confusing it with customer assets", () => {
    expect(
      resolveCampaignImageUrl(
        "/api/v1/public/marketing-assets/campaign_example.jpg",
      ),
    ).toBe(
      "http://localhost:4000/api/v1/public/marketing-assets/campaign_example.jpg",
    );
  });

  it("keeps the original campaign artwork available when the API is unavailable", async () => {
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
      screen.getByRole("heading", { name: /Visa Compass and Ubigi international eSIM/i }),
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
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce({
      ok: true,
      json: async () => ({ data: { FEATURED_BANNER: [], HOW_GUIDE: [], WHY_ESIM_BANNER: [], OFFER_GALLERY: [{ id: "au", title: "Australia travel eSIM offer", altText: "Australia campaign artwork", imageUrl: "/campaigns/australia.webp", placement: "OFFER_GALLERY", format: "PORTRAIT", imageWidth: 1000, imageHeight: 1400, countryCode: "AU", ctaLabel: "View plans", ctaHref: "/destinations?country=AU", sortOrder: 0 }] } }),
    } as Response);
    render(
      <CampaignProvider>
        <OfferGallery />
        <WhyCampaign />
      </CampaignProvider>,
    );

    await waitFor(() =>
      expect(screen.getAllByAltText("Australia campaign artwork")).toHaveLength(3),
    );
    expect(
      screen.getByRole("button", { name: /Enlarge campaign banner/i }),
    ).toBeTruthy();
    fireEvent.click(
      screen.getByRole("button", { name: /view full poster: Australia/i }),
    );
    await waitFor(() =>
      expect(screen.getByRole("dialog").hasAttribute("open")).toBe(true),
    );
    const dialog = screen.getByRole("dialog");
    expect(dialog.textContent).toContain("Australia travel eSIM offer");
    expect(
      within(dialog).getByRole("heading", {
        name: "Australia travel eSIM offer",
      }),
    ).toBeTruthy();
    expect(
      within(dialog)
        .getByRole("link", { name: /view plans/i })
        .getAttribute("href"),
    ).toBe("/destinations?country=AU");

    fireEvent.click(
      screen.getByRole("button", { name: "Close poster viewer" }),
    );
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());

    fireEvent.click(
      screen.getByRole("heading", { name: "Australia travel eSIM offer" }),
    );
    await waitFor(() =>
      expect(screen.getByRole("dialog").hasAttribute("open")).toBe(true),
    );
  });
});
