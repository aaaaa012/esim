"use client";
import { useEffect, useState } from "react";
import { Handshake } from "lucide-react";

const API = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:4000/api/v1";
type Partner = { id: string; name: string; logoUrl?: string | null };

const isPartner = (value: unknown): value is Partner => {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Record<string, unknown>;
  return (
    typeof candidate.id === "string" &&
    typeof candidate.name === "string" &&
    (candidate.logoUrl === undefined ||
      candidate.logoUrl === null ||
      typeof candidate.logoUrl === "string")
  );
};

function PartnerCard({ p }: { p: Partner }) {
  const [broken, setBroken] = useState(false);
  useEffect(() => setBroken(false), [p.logoUrl]);
  return (
    <div className="partner-card">
      {p.logoUrl && !broken ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={p.logoUrl}
          alt={`${p.name} logo`}
          className="partner-logo"
          loading="lazy"
          referrerPolicy="no-referrer"
          onError={() => setBroken(true)}
        />
      ) : (
        <span className="partner-initial">{p.name.charAt(0)}</span>
      )}
      <span className="partner-name">{p.name}</span>
    </div>
  );
}

export default function PartnersShowcase() {
  const [partners, setPartners] = useState<Partner[]>([]);

  useEffect(() => {
    const controller = new AbortController();
    void fetch(`${API}/public/partner-showcase`, {
      cache: "no-store",
      signal: controller.signal,
    })
      .then(async (response) => {
        const value = (await response.json()) as { data?: unknown };
        if (!response.ok)
          throw new Error(
            `Partner showcase request failed (${response.status})`,
          );
        if (!Array.isArray(value.data) || !value.data.every(isPartner))
          throw new Error("Partner showcase returned an invalid response");
        setPartners(value.data);
      })
      .catch((error: unknown) => {
        if (error instanceof DOMException && error.name === "AbortError")
          return;
        // This optional section degrades invisibly for customers, but the
        // failure remains observable to browser monitoring and support tools.
        // eslint-disable-next-line no-console
        console.error("partner_showcase_load_failed", error);
      });
    return () => controller.abort();
  }, []);

  if (!partners.length) return null;

  const visiblePartners = partners.filter((partner, index, all) => {
    const normalized = partner.name.trim().toLowerCase();
    if (
      !normalized ||
      normalized.startsWith("test ") ||
      normalized.includes("demo")
    )
      return false;
    return (
      all.findIndex(
        (candidate) => candidate.name.trim().toLowerCase() === normalized,
      ) === index
    );
  });

  if (!visiblePartners.length) return null;

  const shouldScroll = visiblePartners.length >= 6;
  const trackPartners = shouldScroll
    ? [...visiblePartners, ...visiblePartners]
    : visiblePartners;

  return (
    <section className="section" id="partners">
      <div className="shell">
        <div className="section-title">
          <span className="eyebrow">
            <Handshake size={14} />
            Our partners
          </span>
          <h2>Travel partners on Visa Compass</h2>
          <p>
            Discover eSIM plans offered through our growing network of verified
            travel partners.
          </p>
        </div>
        <div
          className={`partners-track-wrap${shouldScroll ? "" : " is-static"}`}
        >
          <div className={`partners-track${shouldScroll ? "" : " is-static"}`}>
            {trackPartners.map((p, i) => (
              <PartnerCard key={`${p.id}-${i}`} p={p} />
            ))}
          </div>
        </div>
      </div>
    </section>
  );
}
