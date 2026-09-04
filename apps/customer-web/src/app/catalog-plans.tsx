"use client";
import Link from "next/link";
import { useEffect, useState } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import {
  AlertTriangle,
  CheckCircle2,
  ChevronDown,
  Globe2,
  MapPin,
} from "lucide-react";
import CountryPicker, { flagEmoji } from "./country-picker";
import ErrorModal from "../components/error-modal";

const API = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:4000/api/v1";

export type Plan = {
  id: string;
  countryCode: string;
  countryName: string;
  name: string;
  dataAllowance: string;
  allowanceMb?: number | null;
  validityDays: number;
  sellingPriceNpr: number;
  coverage: string[];
  popular: boolean;
};

type Country = { code: string; name: string; popular?: boolean };

type Envelope<T> = {
  data: T;
  meta: { correlationId: string; timestamp: string };
};

export function initialCatalogDestination(
  countries: Country[],
  requested?: string,
) {
  const normalized = requested?.trim().toUpperCase();
  if (normalized && countries.some((country) => country.code === normalized))
    return normalized;
  return (
    countries.find((country) => country.popular)?.code ??
    countries[0]?.code ??
    ""
  );
}

function npr(amount: number) {
  return `NPR ${amount.toLocaleString("en-NP")}`;
}

export function rankCatalogPlans(plans: Plan[]) {
  return [...plans].sort(
    (a, b) =>
      Number(b.popular) - Number(a.popular) ||
      a.sellingPriceNpr - b.sellingPriceNpr,
  );
}

export default function CatalogPlans() {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const targetEsimId = searchParams.get("esim") ?? "";
  const targetCountry = searchParams.get("country") ?? "";
  const [plans, setPlans] = useState<Plan[] | null>(null);
  const [countries, setCountries] = useState<Country[]>([]);
  const [selected, setSelected] = useState<string>("");
  const [popularPlans, setPopularPlans] = useState<Plan[]>([]);
  const [coverage, setCoverage] = useState<Record<string, string>>({});
  const [plansBusy, setPlansBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showAllDestinations, setShowAllDestinations] = useState(false);

  useEffect(() => {
    if (targetCountry) setSelected(targetCountry.toUpperCase());
  }, [targetCountry]);

  useEffect(() => {
    let cancelled = false;
    fetch(`${API}/public/plans?popular=true&limit=6`)
      .then((response) =>
        response.ok ? response.json() : Promise.reject(new Error()),
      )
      .then((value: Envelope<Plan[]>) => {
        if (!cancelled)
          setPopularPlans(
            value.data.filter((plan) => plan.popular).slice(0, 6),
          );
      })
      .catch(() => {
        if (!cancelled) setPopularPlans([]);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    let cancelled = false;
    fetch(`${API}/public/countries`)
      .then((response) =>
        response.ok
          ? response.json()
          : Promise.reject(new Error("catalog unavailable")),
      )
      .then((countriesData: Envelope<Country[]>) => {
        if (cancelled) return;
        setCountries(countriesData.data);
        setSelected((current) =>
          current &&
          countriesData.data.some((country) => country.code === current)
            ? current
            : initialCatalogDestination(countriesData.data, targetCountry),
        );
        setError(null);
      })
      .catch(() => {
        if (cancelled) return;
        setPlans(null);
        setError(
          "Live catalog is unavailable right now. Please try again shortly.",
        );
      });
    return () => {
      cancelled = true;
    };
  }, [targetCountry]);

  useEffect(() => {
    if (!selected) return;
    let cancelled = false;
    setPlansBusy(true);
    fetch(`${API}/public/plans?country=${encodeURIComponent(selected)}`)
      .then((response) =>
        response.ok
          ? response.json()
          : Promise.reject(new Error("catalog unavailable")),
      )
      .then((plansData: Envelope<Plan[]>) => {
        if (!cancelled) {
          setPlans(plansData.data);
          setCoverage((previous) => ({
            ...previous,
            [selected]: plansData.data.length
              ? "Coverage available"
              : "Coverage is unavailable. Please contact Visa Compass for assistance.",
          }));
          setError(null);
        }
      })
      .catch(() => {
        if (!cancelled)
          setError(
            "Plans for this destination could not be loaded. Please try again.",
          );
      })
      .finally(() => {
        if (!cancelled) setPlansBusy(false);
      });
    return () => {
      cancelled = true;
    };
  }, [selected]);

  useEffect(() => {
    if (!selected) return;
    const params = new URLSearchParams(searchParams.toString());
    params.set("country", selected);
    params.delete("data");
    params.delete("days");
    const next = params.toString();
    if (next !== searchParams.toString())
      router.replace(`${pathname}${next ? `?${next}` : ""}`, { scroll: false });
  }, [pathname, router, searchParams, selected]);

  const grouped = new Map<string, Plan[]>();
  for (const plan of plans ?? [])
    grouped.set(plan.countryCode, [
      ...(grouped.get(plan.countryCode) ?? []),
      plan,
    ]);
  const countryList = countries.length
    ? countries
    : [...grouped.entries()].map(([code, items]) => ({
        code,
        name: items[0]?.countryName ?? code,
      }));
  const destinationPlans = selected ? (grouped.get(selected) ?? []) : [];
  const visible = rankCatalogPlans(destinationPlans);
  const destinationPopular = destinationPlans.filter((plan) => plan.popular);
  const coverageMessage = selected ? coverage[selected] : undefined;
  const popularCountries = new Set(
    countries
      .filter((country) => country.popular)
      .map((country) => country.code),
  );
  const supported = [...countryList].sort(
    (a, b) =>
      Number(popularCountries.has(b.code)) -
        Number(popularCountries.has(a.code)) || a.name.localeCompare(b.name),
  );
  const selectDestination = (code: string) => {
    setSelected(code);
    setShowAllDestinations(false);
    requestAnimationFrame(() => {
      document
        .getElementById("plan-picker")
        ?.scrollIntoView({ behavior: "smooth", block: "center" });
    });
  };

  const focusPopularPlan = (plan: Plan) => {
    setSelected(plan.countryCode);
    requestAnimationFrame(() => {
      document
        .getElementById("plan-results")
        ?.scrollIntoView({ behavior: "smooth", block: "start" });
    });
  };

  return (
    <>
      {popularPlans.length ? (
        <section
          className="popular-plan-showcase"
          aria-labelledby="popular-plans-title"
        >
          <div className="popular-plan-heading">
            <div>
              <span className="destination-eyebrow">Customer favourites</span>
              <h3 id="popular-plans-title">Popular eSIM plans</h3>
            </div>
            <p>Quick picks curated by Visa Compass.</p>
          </div>
          <div className="popular-plan-grid">
            {popularPlans.map((plan) => (
              <article className="popular-plan-card" key={plan.id}>
                <div className="popular-plan-country">
                  <span className="destination-flag">
                    {flagEmoji(plan.countryCode)}
                  </span>
                  <span>
                    <b>{plan.countryName}</b>
                    <small>Popular package</small>
                  </span>
                </div>
                <h4>{plan.name}</h4>
                <p>
                  {plan.dataAllowance} · {plan.validityDays} days
                </p>
                <div className="popular-plan-price">
                  <b>{npr(plan.sellingPriceNpr)}</b>
                  <button type="button" onClick={() => focusPopularPlan(plan)}>
                    View plan
                  </button>
                </div>
              </article>
            ))}
          </div>
        </section>
      ) : null}
      <section
        className="supported-destinations"
        aria-labelledby="supported-destinations-title"
      >
        <div className="supported-heading">
          <div>
            <span className="destination-eyebrow">
              <Globe2 size={14} /> Global coverage
            </span>
            <h3 id="supported-destinations-title">Find your ideal plan</h3>
            <p>Choose a destination to see its available plans.</p>
          </div>
          {plans ? (
            <span className="destination-count">
              {supported.length} destinations
            </span>
          ) : null}
        </div>
        <div className="destination-picker" id="plan-picker">
          <CountryPicker
            countries={countryList}
            value={selected}
            onChange={selectDestination}
            disabled={!countries.length}
          />
          {countries.length ? (
            <small className="picker-help">
              Type a country name to quickly find your plan.
            </small>
          ) : null}
        </div>

        {!countries.length && !error ? (
          <div
            className="destination-grid popular-grid loading"
            aria-label="Loading destinations"
          >
            <span />
            <span />
            <span />
          </div>
        ) : null}

        {destinationPopular.length ? (
          <div className="destination-popular-plans">
            <p className="destination-subtitle">
              Popular for{" "}
              {countryList.find((country) => country.code === selected)?.name}
            </p>
            <div className="destination-plan-chips">
              {destinationPopular.map((plan) => (
                <button
                  key={plan.id}
                  type="button"
                  onClick={() => focusPopularPlan(plan)}
                >
                  <b>{plan.dataAllowance}</b>
                  <span>
                    {plan.validityDays} days · {npr(plan.sellingPriceNpr)}
                  </span>
                </button>
              ))}
            </div>
          </div>
        ) : null}

        {plans && supported.length ? (
          <div className="all-destinations">
            <button
              type="button"
              className="all-destinations-toggle"
              aria-expanded={showAllDestinations}
              aria-controls="all-destinations-grid"
              onClick={() => setShowAllDestinations((current) => !current)}
            >
              <span>
                {showAllDestinations
                  ? "Hide destination directory"
                  : `Browse all ${supported.length} destinations`}
              </span>
              <ChevronDown
                size={17}
                className={showAllDestinations ? "is-open" : ""}
              />
            </button>
            {showAllDestinations ? (
              <div
                className="destination-grid directory-grid"
                id="all-destinations-grid"
              >
                {supported.map((country) => (
                  <button
                    key={country.code}
                    type="button"
                    className={selected === country.code ? "selected" : ""}
                    aria-pressed={selected === country.code}
                    onClick={() => selectDestination(country.code)}
                  >
                    <span className="destination-flag">
                      {flagEmoji(country.code)}
                    </span>
                    <b>{country.name}</b>
                  </button>
                ))}
              </div>
            ) : null}
          </div>
        ) : !error && plans ? (
          <p className="catalog-empty">
            No supported destinations are currently available.
          </p>
        ) : null}
      </section>
      {error ? (
        <ErrorModal error={error} onClose={() => setError(null)} />
      ) : null}
      {coverageMessage ? (
        <div
          className={`coverage-note ${coverageMessage === "Coverage available" ? "ok" : "warn"}`}
        >
          {coverageMessage === "Coverage available" ? (
            <CheckCircle2 size={16} />
          ) : (
            <AlertTriangle size={16} />
          )}
          <span>{coverageMessage}</span>
        </div>
      ) : null}
      {!selected ? (
        <p className="catalog-empty">
          Select a destination above to see its available plans.
        </p>
      ) : plansBusy ? (
        <p className="catalog-empty">Loading plans for this destination…</p>
      ) : visible.length ? (
        <div className="cards" id="plan-results">
          {visible.map((plan) => (
            <article className="card" key={plan.id}>
              {plan.popular ? <span className="badge">POPULAR</span> : null}
              <span className="flag">{flagEmoji(plan.countryCode)}</span>
              <h3>{plan.name}</h3>
              <p className="plan-meta">
                <MapPin size={13} style={{ verticalAlign: -2 }} />{" "}
                {plan.countryName} · <strong>{plan.dataAllowance}</strong> ·{" "}
                {plan.validityDays} days
              </p>
              <div className="price">
                <b>{npr(plan.sellingPriceNpr)}</b>
                <Link
                  className="button"
                  href={`/esim/checkout?plan=${plan.id}${targetEsimId ? `&esim=${encodeURIComponent(targetEsimId)}&country=${encodeURIComponent(targetCountry)}` : ""}`}
                >
                  {targetEsimId && plan.countryCode === targetCountry
                    ? "Recharge"
                    : "Choose"}
                </Link>
              </div>
            </article>
          ))}
        </div>
      ) : (
        <p className="catalog-empty">
          No plans available for this destination yet.
        </p>
      )}
    </>
  );
}
