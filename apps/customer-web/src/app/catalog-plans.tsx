"use client";
import Link from "next/link";
import { useEffect, useState } from "react";
import { AlertTriangle, CheckCircle2, MapPin } from "lucide-react";
import CountryPicker, { flagEmoji } from "./country-picker";

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

type Country = { code: string; name: string };

type Envelope<T> = { data: T; meta: { correlationId: string; timestamp: string } };

function npr(amount: number) {
  return `NPR ${amount.toLocaleString("en-NP")}`;
}

export default function CatalogPlans() {
  const [plans, setPlans] = useState<Plan[] | null>(null);
  const [countries, setCountries] = useState<Country[]>([]);
  const [selected, setSelected] = useState<string>("");
  const [coverage, setCoverage] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  const [topUpMobile, setTopUpMobile] = useState("");
  const [topUpCountry, setTopUpCountry] = useState("");

  useEffect(() => {
    try {
      setTopUpMobile(sessionStorage.getItem("vc_topup_mobile") ?? "");
      setTopUpCountry(sessionStorage.getItem("vc_topup_country") ?? "");
    } catch {
      setTopUpMobile("");
      setTopUpCountry("");
    }
  }, []);

  useEffect(() => {
    let cancelled = false;
    Promise.all([fetch(`${API}/public/plans`), fetch(`${API}/public/countries`)])
      .then(([plansResponse, countriesResponse]) =>
        Promise.all([
          plansResponse.ok ? plansResponse.json() : Promise.reject(new Error("catalog unavailable")),
          countriesResponse.ok ? countriesResponse.json() : Promise.reject(new Error("catalog unavailable")),
        ]),
      )
      .then(([plansData, countriesData]: [Envelope<Plan[]>, Envelope<Country[]>]) => {
        if (cancelled) return;
        setPlans(plansData.data);
        setCountries(countriesData.data);
        setError(null);
      })
      .catch(() => {
        if (cancelled) return;
        setPlans(null);
        setError("Live catalog is unavailable right now. Please try again shortly.");
      });
    return () => {
      cancelled = true;
    };
  }, []);

  // When a top-up lookup has pinned a destination, default to it so only that
  // country's plans are offered (the ones that can recharge the existing eSIM).
  useEffect(() => {
    if (topUpCountry && countries.some((country) => country.code === topUpCountry)) {
      setSelected(topUpCountry);
    }
  }, [topUpCountry, countries]);

  useEffect(() => {
    if (!selected) return;
    let cancelled = false;
    fetch(`${API}/public/coverage/${selected}`)
      .then((response) => (response.ok ? response.json() : Promise.reject(new Error("coverage unavailable"))))
      .then((data: Envelope<{ available: boolean; message: string }>) => {
        if (!cancelled) setCoverage((previous) => ({ ...previous, [selected]: data.data.message }));
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [selected]);

  const grouped = new Map<string, Plan[]>();
  for (const plan of plans ?? []) grouped.set(plan.countryCode, [...(grouped.get(plan.countryCode) ?? []), plan]);
  const countryList = countries.length
    ? countries
    : [...grouped.entries()].map(([code, items]) => ({ code, name: items[0]?.countryName ?? code }));
  const visible = selected ? (grouped.get(selected) ?? []) : [];
  const coverageMessage = selected ? coverage[selected] : undefined;

  return (
    <>
      <div className="destination-picker">
        <CountryPicker countries={countryList} value={selected} onChange={setSelected} disabled={!plans} />
        {topUpMobile && selected && (
          <small className="topup-context">
            Recharging {selected ? countryList.find((country) => country.code === selected)?.name ?? selected : ""} for
            {` ${topUpMobile}`}.
          </small>
        )}
      </div>
      {error ? <div className="catalog-error">{error}</div> : null}
      {coverageMessage ? (
        <div className={`coverage-note ${coverageMessage === "Coverage available" ? "ok" : "warn"}`}>
          {coverageMessage === "Coverage available" ? <CheckCircle2 size={16} /> : <AlertTriangle size={16} />}
          <span>{coverageMessage}</span>
        </div>
      ) : null}
      {!selected ? (
        <p className="catalog-empty">Select a destination above to see its available plans.</p>
      ) : visible.length ? (
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
