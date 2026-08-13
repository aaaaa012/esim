'use client';
import { useEffect, useState } from 'react';
import { Handshake } from 'lucide-react';

const API = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:4000/api/v1';
type Partner = { id: string; name: string; logoUrl?: string | null };

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
    fetch(`${API}/public/partner-showcase`, { cache: 'no-store' })
      .then((r) => r.json())
      .then((v) => setPartners(v.data ?? []))
      .catch(() => {});
  }, []);

  if (!partners.length) return null;

  const visiblePartners = partners.filter((partner, index, all) => {
    const normalized = partner.name.trim().toLowerCase();
    if (!normalized || normalized.startsWith('test ') || normalized.includes('demo')) return false;
    return all.findIndex((candidate) => candidate.name.trim().toLowerCase() === normalized) === index;
  });

  if (!visiblePartners.length) return null;

  const shouldScroll = visiblePartners.length >= 6;
  const trackPartners = shouldScroll ? [...visiblePartners, ...visiblePartners] : visiblePartners;

  return (
    <section className="section" id="partners">
      <div className="shell">
        <div className="section-title">
          <span className="eyebrow">
            <Handshake size={14} />
            Our partners
          </span>
          <h2>Travel partners on Visa Compass</h2>
          <p>Discover eSIM plans offered through our growing network of verified travel partners.</p>
        </div>
        <div className={`partners-track-wrap${shouldScroll ? '' : ' is-static'}`}>
          <div className={`partners-track${shouldScroll ? '' : ' is-static'}`}>
            {trackPartners.map((p, i) => (
              <PartnerCard key={`${p.id}-${i}`} p={p} />
            ))}
          </div>
        </div>
      </div>
    </section>
  );
}
