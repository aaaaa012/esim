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

  return (
    <section className="section" id="partners">
      <div className="shell">
        <div className="section-title">
          <span className="eyebrow">
            <Handshake size={14} />
            Our partners
          </span>
          <h2>Trusted by leading travel providers</h2>
          <p>We work with the best to keep you connected wherever you land.</p>
        </div>
        <div className="partners-track-wrap">
          <div className="partners-track">
            {[...partners, ...partners].map((p, i) => (
              <PartnerCard key={`${p.id}-${i}`} p={p} />
            ))}
          </div>
        </div>
      </div>
    </section>
  );
}
