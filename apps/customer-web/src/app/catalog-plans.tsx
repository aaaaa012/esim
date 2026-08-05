"use client";
import Link from "next/link";
import { useEffect, useState } from "react";
import { AlertTriangle, CheckCircle2, MapPin } from "lucide-react";

const API = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:4000/api/v1";

type Plan = {
  id: string;
  countryCode: string;
  countryName: string;
  name: string;
  dataAllowance: string;
  validityDays: number;
  sellingPriceNpr: number;
  coverage: string[];
  popular: boolean;
};

const fallbackPlans: Plan[] = [
  { id: "10000000-0000-4000-8000-000000000001", countryCode: "AE", countryName: "United Arab Emirates", name: "UAE Essential", dataAllowance: "5 GB", validityDays: 15, sellingPriceNpr: 2499, coverage: ["UAE"], popular: true },
  { id: "10000000-0000-4000-8000-000000000002", countryCode: "GB", countryName: "United Kingdom", name: "UK Explorer", dataAllowance: "10 GB", validityDays: 30, sellingPriceNpr: 3999, coverage: ["United Kingdom"], popular: true },
  { id: "10000000-0000-4000-8000-000000000003", countryCode: "JP", countryName: "Japan", name: "Japan Connect", dataAllowance: "3 GB", validityDays: 7, sellingPriceNpr: 1899, coverage: ["Japan"], popular: false },
];

function flagEmoji(countryCode: string) {
  return countryCode.toUpperCase().replace(/./g, (char) => String.fromCodePoint(127397 + char.charCodeAt(0)));
}

function npr(amount: number) {
  return `NPR ${amount.toLocaleString("en-NP")}`;
}

export default function CatalogPlans() {
  const [plans, setPlans] = useState<Plan[] | null>(null);
  const [country, setCountry] = useState("ALL");
  const [coverage, setCoverage] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  const [topUpMobile, setTopUpMobile] = useState("");
  useEffect(() => {
    try {
      setTopUpMobile(sessionStorage.getItem("vc_topup_mobile") ?? "");
    } catch {
      setTopUpMobile("");
    }
  }, []);

  useEffect(() => {
    let cancelled = false;
    fetch(`${API}/public/plans`)
      .then((response) => {
        if (!response.ok) throw new Error("catalog unavailable");
        return response.json() as Promise<Plan[]>;
      })
      .then((data) => {
        if (cancelled) return;
        setPlans(data.length ? data : fallbackPlans);
        setError(null);
      })
      .catch(() => {
        if (cancelled) return;
        setPlans(fallbackPlans);
        setError("Live catalog is unavailable right now — showing sample plans.");
      });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (!country || country === "ALL") return;
    let cancelled = false;
    fetch(`${API}/public/coverage/${country}`)
      .then((response) => (response.ok ? response.json() : Promise.reject(new Error("coverage unavailable"))))
      .then((data: { available: boolean; message: string }) => {
        if (!cancelled) setCoverage((previous) => ({ ...previous, [country]: data.message }));
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [country]);

  const grouped = new Map<string, Plan[]>();
  for (const plan of plans ?? []) grouped.set(plan.countryCode, [...(grouped.get(plan.countryCode) ?? []), plan]);
  const countryList = [...grouped.entries()].map(([code, items]) => ({ code, name: items[0]?.countryName ?? code }));
  const visible = country === "ALL" ? plans ?? [] : (grouped.get(country) ?? []);
  const coverageMessage = country !== "ALL" ? coverage[country] : undefined;

  return (
    <>
      <div className="catalog-tabs">
        <button type="button" className={`catalog-tab ${country === "ALL" ? "active" : ""}`} onClick={() => setCountry("ALL")} disabled={!plans}>
          All destinations
        </button>
        {countryList.map(({ code, name }) => (
          <button type="button" key={code} className={`catalog-tab ${country === code ? "active" : ""}`} onClick={() => setCountry(code)} disabled={!plans}>
            {flagEmoji(code)} {name}
          </button>
        ))}
      </div>
      {error ? <div className="catalog-error">{error}</div> : null}
      {coverageMessage ? (
        <div className={`coverage-note ${coverageMessage === "Coverage available" ? "ok" : "warn"}`}>
          {coverageMessage === "Coverage available" ? <CheckCircle2 size={16} /> : <AlertTriangle size={16} />}
          <span>{coverageMessage}</span>
        </div>
      ) : null}
      {visible.length ? (
        <div className="cards">
          {visible.map((plan) => (
            <article className="card" key={plan.id}>
              {plan.popular ? <span className="badge">POPULAR</span> : null}
              <span className="flag">{flagEmoji(plan.countryCode)}</span>
              <h3>{plan.name}</h3>
              <p className="plan-meta">
                <MapPin size={13} style={{ verticalAlign: -2 }} /> {plan.countryName} · <strong>{plan.dataAllowance}</strong> · {plan.validityDays} days
              </p>
              <div className="price">
                <b>{npr(plan.sellingPriceNpr)}</b>
                <Link className="button" href={`/esim/checkout?plan=${plan.id}${topUpMobile ? `&mobile=${encodeURIComponent(topUpMobile)}` : ""}`}>
                  {topUpMobile ? "Recharge" : "Choose"}
                </Link>
              </div>
            </article>
          ))}
        </div>
      ) : (
        <p className="catalog-empty">No plans available for this destination yet.</p>
      )}
    </>
  );
}
