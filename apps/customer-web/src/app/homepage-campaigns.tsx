"use client";

import Image from "next/image";
import Link from "next/link";
import { ArrowLeft, ArrowRight, ExternalLink, Wifi, X } from "lucide-react";
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";

const API = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:4000/api/v1";

export function resolveCampaignImageUrl(imageUrl: string) {
  if (!imageUrl.startsWith("/api/v1/")) return imageUrl;
  try {
    return `${new URL(API).origin}${imageUrl}`;
  } catch {
    return imageUrl;
  }
}

type Placement =
  "FEATURED_BANNER" | "OFFER_GALLERY" | "HOW_GUIDE" | "WHY_ESIM_BANNER";

export type HomepageCampaign = {
  id: string;
  title: string;
  altText: string;
  imageUrl: string;
  placement: Placement;
  format: "PORTRAIT" | "SQUARE" | "LANDSCAPE";
  imageWidth: number;
  imageHeight: number;
  countryCode: string | null;
  ctaLabel: string;
  ctaHref: string;
  sortOrder: number;
};

type CampaignGroups = Record<Placement, HomepageCampaign[]>;

const entries: Array<
  Omit<HomepageCampaign, "id" | "placement" | "sortOrder"> & {
    id: string;
    placement: Placement;
    sortOrder: number;
  }
> = [
  {
    id: "featured-nepali-partnership",
    title: "Visa Compass and Ubigi international eSIM",
    altText:
      "Nepali campaign introducing Visa Compass and Ubigi travel eSIM for more than 200 destinations.",
    imageUrl: "/campaigns/nepali-partnership.webp",
    placement: "FEATURED_BANNER",
    format: "LANDSCAPE",
    imageWidth: 1600,
    imageHeight: 477,
    countryCode: null,
    ctaLabel: "Browse travel plans",
    ctaHref: "/#plans",
    sortOrder: 0,
  },
  ...[
    ["Australia", "AU", "australia.webp"],
    ["Japan", "JP", "japan.webp"],
    ["Malaysia", "MY", "malaysia.webp"],
    ["Singapore", "SG", "singapore.webp"],
    ["Thailand", "TH", "thailand.webp"],
    ["United Arab Emirates", "AE", "uae.webp"],
    ["United Kingdom", "GB", "uk.webp"],
    ["Vietnam", "VN", "vietnam.webp"],
  ].map(([country, code, file], index) => ({
    id: `destination-${code!.toLowerCase()}`,
    title: `${country} travel eSIM offer`,
    altText: `${country} travel eSIM package offer from Visa Compass and Ubigi, with pricing in Nepali rupees.`,
    imageUrl: `/campaigns/${file}`,
    placement: "OFFER_GALLERY" as const,
    format: "PORTRAIT" as const,
    imageWidth: 768,
    imageHeight: 1376,
    countryCode: code!,
    ctaLabel: "View plans",
    ctaHref: `/destinations?country=${code}`,
    sortOrder: index,
  })),
  {
    id: "general-mobile-internet",
    title: "Global internet without roaming fees",
    altText:
      "Traveller using a phone with a summary of Visa Compass and Ubigi global eSIM benefits.",
    imageUrl: "/campaigns/mobile-internet-benefits.webp",
    placement: "OFFER_GALLERY",
    format: "PORTRAIT",
    imageWidth: 1165,
    imageHeight: 1600,
    countryCode: null,
    ctaLabel: "Browse destinations",
    ctaHref: "/#plans",
    sortOrder: 20,
  },
  ...[
    ["Purchase and top up in Nepali rupees", "npr-purchase.webp", 1240, 1247],
    ["One eSIM for a lifetime of travel", "one-esim-for-life.webp", 1250, 1250],
  ].map(([title, file, width, height], index) => ({
    id: `general-square-${index}`,
    title: String(title),
    altText: `${title} through the Visa Compass and Ubigi travel eSIM partnership.`,
    imageUrl: `/campaigns/${file}`,
    placement: "OFFER_GALLERY" as const,
    format: "SQUARE" as const,
    imageWidth: Number(width),
    imageHeight: Number(height),
    countryCode: null,
    ctaLabel: "Browse travel plans",
    ctaHref: "/#plans",
    sortOrder: 30 + index,
  })),
  {
    id: "setup-guide",
    title: "Getting started with your eSIM",
    altText:
      "Three-step setup guide showing compatibility check, plan purchase, and QR code activation.",
    imageUrl: "/campaigns/getting-started-guide.webp",
    placement: "HOW_GUIDE",
    format: "PORTRAIT",
    imageWidth: 1165,
    imageHeight: 1600,
    countryCode: null,
    ctaLabel: "Check compatibility",
    ctaHref: "/compatibility",
    sortOrder: 0,
  },
  {
    id: "partnership-benefits",
    title: "Why travel with Visa Compass and Ubigi",
    altText:
      "Visa Compass and Ubigi partnership banner summarizing international eSIM purchase, top-up, installation, and hotspot benefits.",
    imageUrl: "/campaigns/partnership-benefits.webp",
    placement: "WHY_ESIM_BANNER",
    format: "LANDSCAPE",
    imageWidth: 1600,
    imageHeight: 477,
    countryCode: null,
    ctaLabel: "Browse travel plans",
    ctaHref: "/#plans",
    sortOrder: 0,
  },
];

function fallbackGroups(): CampaignGroups {
  return {
    FEATURED_BANNER: entries.filter(
      (item) => item.placement === "FEATURED_BANNER",
    ),
    OFFER_GALLERY: entries.filter((item) => item.placement === "OFFER_GALLERY"),
    HOW_GUIDE: entries.filter((item) => item.placement === "HOW_GUIDE"),
    WHY_ESIM_BANNER: entries.filter(
      (item) => item.placement === "WHY_ESIM_BANNER",
    ),
  };
}

type CampaignContextValue = {
  groups: CampaignGroups;
  openCampaign: (campaign: HomepageCampaign) => void;
};

const CampaignContext = createContext<CampaignContextValue | null>(null);

function useCampaigns() {
  const value = useContext(CampaignContext);
  if (!value) throw new Error("Campaign components require CampaignProvider");
  return value;
}

function CampaignImage({
  campaign,
  sizes,
  priority = false,
}: {
  campaign: HomepageCampaign;
  sizes: string;
  priority?: boolean;
}) {
  const [broken, setBroken] = useState(false);
  useEffect(() => setBroken(false), [campaign.imageUrl]);
  if (broken)
    return (
      <span
        className="campaign-image-unavailable"
        role="img"
        aria-label={campaign.altText}
      >
        Artwork temporarily unavailable
      </span>
    );
  return (
    <Image
      src={resolveCampaignImageUrl(campaign.imageUrl)}
      alt={campaign.altText}
      width={campaign.imageWidth}
      height={campaign.imageHeight}
      sizes={sizes}
      priority={priority}
      onError={() => setBroken(true)}
    />
  );
}

export function CampaignProvider({ children }: { children: ReactNode }) {
  const [groups, setGroups] = useState<CampaignGroups>(fallbackGroups);
  const [selected, setSelected] = useState<HomepageCampaign | null>(null);
  const dialogRef = useRef<HTMLDialogElement>(null);

  useEffect(() => {
    const controller = new AbortController();
    fetch(`${API}/public/homepage-campaigns`, { signal: controller.signal })
      .then(async (response) => {
        if (!response.ok) throw new Error("Campaign service unavailable");
        return (await response.json()) as { data: CampaignGroups };
      })
      .then((response) => setGroups(response.data))
      .catch((error: unknown) => {
        if (!(error instanceof DOMException && error.name === "AbortError")) {
          setGroups(fallbackGroups());
        }
      });
    return () => controller.abort();
  }, []);

  useEffect(() => {
    if (selected && !dialogRef.current?.open) dialogRef.current?.showModal();
  }, [selected]);

  const close = useCallback(() => dialogRef.current?.close(), []);

  return (
    <CampaignContext.Provider value={{ groups, openCampaign: setSelected }}>
      {children}
      <dialog
        className="campaign-dialog"
        ref={dialogRef}
        onClose={() => setSelected(null)}
        aria-labelledby="campaign-dialog-title"
      >
        {selected ? (
          <div className="campaign-dialog-inner">
            <div className="campaign-dialog-head">
              <h2 id="campaign-dialog-title">{selected.title}</h2>
              <button
                type="button"
                onClick={close}
                aria-label="Close poster viewer"
              >
                <X size={20} />
              </button>
            </div>
            <div
              className={`campaign-dialog-art is-${selected.format.toLowerCase()}`}
            >
              <CampaignImage
                campaign={selected}
                sizes="(max-width: 760px) 94vw, 84vw"
                priority
              />
            </div>
            <div className="campaign-dialog-actions">
              <button
                type="button"
                className="button secondary"
                onClick={close}
              >
                Close
              </button>
              <Link className="button" href={selected.ctaHref} onClick={close}>
                {selected.ctaLabel} <ExternalLink size={16} />
              </Link>
            </div>
          </div>
        ) : null}
      </dialog>
    </CampaignContext.Provider>
  );
}

export function PoweredByBar() {
  return (
    <div className="powered-by-bar" aria-label="Connectivity partner">
      <span>Travel eSIM connectivity</span>
      <b>powered by Ubigi</b>
    </div>
  );
}

export function FeaturedCampaign() {
  const { groups, openCampaign } = useCampaigns();
  const campaign = groups.FEATURED_BANNER[0];
  if (!campaign) return null;
  return (
    <section
      className="campaign-featured"
      aria-labelledby="featured-campaign-heading"
    >
      <div className="shell">
        <div className="campaign-section-heading">
          <div>
            <span className="eyebrow">Featured partnership</span>
            <h2 id="featured-campaign-heading">
              Travel connected, wherever you land.
            </h2>
          </div>
          <span className="campaign-section-note">Visa Compass × Ubigi</span>
        </div>
        <button
          className="campaign-landscape-art"
          type="button"
          onClick={() => openCampaign(campaign)}
          aria-label={`View full poster: ${campaign.title}`}
        >
          <CampaignImage
            campaign={campaign}
            sizes="(max-width: 1180px) 100vw, 1132px"
            priority
          />
        </button>
        <div className="campaign-under-art">
          <span>Select the artwork to read it at full size.</span>
          <Link className="button" href={campaign.ctaHref}>
            {campaign.ctaLabel} <ArrowRight size={17} />
          </Link>
        </div>
      </div>
    </section>
  );
}

export function OfferGallery() {
  const { groups, openCampaign } = useCampaigns();
  const railRef = useRef<HTMLDivElement>(null);
  const scrollEndRef = useRef<number | null>(null);
  const pausedRef = useRef(false);
  const campaigns = groups.OFFER_GALLERY;
  const move = useCallback((direction: -1 | 1) => {
    const rail = railRef.current;
    if (!rail) return;
    const card = rail.querySelector<HTMLElement>('[data-loop-set="1"]');
    const gap = Number.parseFloat(getComputedStyle(rail).columnGap || "18");
    rail.scrollBy({
      left:
        direction *
        Math.max(
          280,
          (card?.getBoundingClientRect().width ?? rail.clientWidth * 0.78) +
            gap,
        ),
      behavior: "smooth",
    });
  }, []);

  const loopMetrics = useCallback(() => {
    const starts = railRef.current?.querySelectorAll<HTMLElement>(
      '[data-loop-start="true"]',
    );
    if (!starts || starts.length < 3) return null;
    return {
      start: starts[1]!.offsetLeft,
      cycle: starts[2]!.offsetLeft - starts[1]!.offsetLeft,
    };
  }, []);

  const normalizeLoop = useCallback(() => {
    if (scrollEndRef.current) window.clearTimeout(scrollEndRef.current);
    scrollEndRef.current = window.setTimeout(() => {
      const rail = railRef.current;
      const metrics = loopMetrics();
      if (!rail || !metrics || !metrics.cycle) return;
      if (rail.scrollLeft < metrics.start - 2) rail.scrollLeft += metrics.cycle;
      else if (rail.scrollLeft >= metrics.start + metrics.cycle - 2)
        rail.scrollLeft -= metrics.cycle;
    }, 120);
  }, [loopMetrics]);

  useEffect(() => {
    const rail = railRef.current;
    if (!rail || !campaigns.length) return;
    const position = window.requestAnimationFrame(() => {
      const metrics = loopMetrics();
      if (metrics) rail.scrollLeft = metrics.start;
    });
    const reducedMotion =
      typeof window.matchMedia === "function" &&
      window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    const timer = reducedMotion
      ? null
      : window.setInterval(() => {
          if (!pausedRef.current && document.visibilityState === "visible")
            move(1);
        }, 4200);
    return () => {
      window.cancelAnimationFrame(position);
      if (timer) window.clearInterval(timer);
      if (scrollEndRef.current) window.clearTimeout(scrollEndRef.current);
    };
  }, [campaigns.length, loopMetrics, move]);

  if (!campaigns.length) return null;
  const loopedCampaigns = [0, 1, 2].flatMap((setIndex) =>
    campaigns.map((campaign, campaignIndex) => ({
      campaign,
      campaignIndex,
      setIndex,
    })),
  );
  return (
    <section
      className="campaign-gallery-section"
      aria-labelledby="campaign-gallery-heading"
    >
      <div className="shell">
        <div className="campaign-gallery-head">
          <div>
            <span className="eyebrow">Current offers</span>
            <h2 id="campaign-gallery-heading">
              Choose where the journey takes you.
            </h2>
            <p>
              Open any poster for offer details and a direct route to matching
              plans.
            </p>
            <span className="campaign-gallery-motion-note">
              Offers rotate automatically. Hover or focus the gallery to pause.
            </span>
          </div>
          <div
            className="campaign-gallery-controls"
            aria-label="Offer gallery controls"
          >
            <button
              type="button"
              onClick={() => move(-1)}
              aria-label="Previous offers"
            >
              <ArrowLeft size={18} />
            </button>
            <button
              type="button"
              onClick={() => move(1)}
              aria-label="Next offers"
            >
              <ArrowRight size={18} />
            </button>
          </div>
        </div>
        <div
          className="campaign-rail"
          ref={railRef}
          tabIndex={0}
          onScroll={normalizeLoop}
          onMouseEnter={() => (pausedRef.current = true)}
          onMouseLeave={() => (pausedRef.current = false)}
          onFocusCapture={() => (pausedRef.current = true)}
          onBlurCapture={(event) => {
            if (!event.currentTarget.contains(event.relatedTarget))
              pausedRef.current = false;
          }}
          onPointerDown={() => (pausedRef.current = true)}
          onPointerUp={() => (pausedRef.current = false)}
          aria-label="Current travel offers"
        >
          {loopedCampaigns.map(({ campaign, campaignIndex, setIndex }) => (
            <article
              className={`campaign-card is-${campaign.format.toLowerCase()}`}
              key={`${setIndex}-${campaign.id}`}
              data-loop-set={setIndex}
              data-loop-start={campaignIndex === 0 ? "true" : undefined}
              aria-hidden={setIndex === 1 ? undefined : true}
            >
              <button
                className="campaign-card-art"
                type="button"
                onClick={() => openCampaign(campaign)}
                aria-label={`View full poster: ${campaign.title}`}
                tabIndex={setIndex === 1 ? undefined : -1}
              >
                <CampaignImage
                  campaign={campaign}
                  sizes="(max-width: 560px) 80vw, (max-width: 900px) 44vw, 30vw"
                />
              </button>
              <div className="campaign-card-copy">
                <div className="campaign-card-meta" aria-hidden="true">
                  <span>{campaign.countryCode ?? "Global offer"}</span>
                  <small>{String(campaignIndex + 1).padStart(2, "0")}</small>
                </div>
                <h3>{campaign.title}</h3>
                <Link
                  href={campaign.ctaHref}
                  tabIndex={setIndex === 1 ? undefined : -1}
                >
                  {campaign.ctaLabel} <ArrowRight size={15} />
                </Link>
              </div>
            </article>
          ))}
        </div>
      </div>
    </section>
  );
}

export function GuideCampaign() {
  const { groups, openCampaign } = useCampaigns();
  const campaign = groups.HOW_GUIDE[0];
  if (!campaign) return null;
  return (
    <figure className="campaign-guide">
      <button
        className="campaign-guide-art"
        type="button"
        onClick={() => openCampaign(campaign)}
        aria-label={`Enlarge setup poster: ${campaign.title}`}
      >
        <CampaignImage
          campaign={campaign}
          sizes="(max-width: 860px) 100vw, 42vw"
        />
      </button>
      <figcaption className="journey-caption">
        <span>
          <Wifi size={17} aria-hidden="true" />
        </span>
        <div>
          <b>Ready before takeoff</b>
          <small>Keep the full guide handy while you install.</small>
        </div>
        <button type="button" onClick={() => openCampaign(campaign)}>
          View full setup guide
        </button>
      </figcaption>
    </figure>
  );
}

export function WhyCampaign() {
  const { groups, openCampaign } = useCampaigns();
  const campaign = groups.WHY_ESIM_BANNER[0];
  if (!campaign) return null;
  return (
    <div className="why-campaign">
      <button type="button" onClick={() => openCampaign(campaign)}>
        <CampaignImage
          campaign={campaign}
          sizes="(max-width: 1180px) 100vw, 1132px"
        />
      </button>
      <Link href={campaign.ctaHref}>
        {campaign.ctaLabel} <ArrowRight size={15} />
      </Link>
    </div>
  );
}
