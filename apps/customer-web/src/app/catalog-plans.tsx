"use client";
import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import {
  AlertTriangle,
  CheckCircle2,
  ChevronDown,
  Globe2,
  MapPin,
} from "lucide-react";
import CountryPicker, { flagEmoji } from "./country-picker";

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

export function catalogDestinationHref(
  pathname: string,
  currentSearch: string,
  countryCode: string,
) {
  const params = new URLSearchParams(currentSearch);
  params.set("country", countryCode);
  params.delete("data");
  params.delete("days");
  const query = params.toString();
  return `${pathname === "/destinations" ? pathname : "/destinations"}${
    query ? `?${query}` : ""
  }`;
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
  const [attempt, setAttempt] = useState(0);
  const [countriesBusy, setCountriesBusy] = useState(true);
  const [plansBusy, setPlansBusy] = useState(false);
  const [countriesError, setCountriesError] = useState<string | null>(null);
  const [plansError, setPlansError] = useState<string | null>(null);
  const error = countriesError || plansError;
  const [showAllDestinations, setShowAllDestinations] = useState(false);
  const revealResultsFor = useRef<string | null>(null);

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
    setCountriesBusy(true);
    setCountriesError(null);
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
        setCountriesError(null);
      })
      .catch(() => {
        if (cancelled) return;
        setPlans(null);
        setCountriesError(
          "Live catalog is unavailable right now. Please try again shortly.",
        );
      })
      .finally(() => {
        if (!cancelled) setCountriesBusy(false);
      });
    return () => {
      cancelled = true;
    };
  }, [attempt]);

  useEffect(() => {
    if (!selected) return;
    let cancelled = false;
    setPlansBusy(true);
    setPlans(null);
    setPlansError(null);
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
          setPlansError(null);
        }
      })
      .catch(() => {
        if (!cancelled)
          setPlansError(
            "Plans for this destination could not be loaded. Please try again.",
          );
      })
      .finally(() => {
        if (!cancelled) setPlansBusy(false);
      });
    return () => {
      cancelled = true;
    };
  }, [selected, attempt]);

  useEffect(() => {
    if (plansBusy || plans === null || revealResultsFor.current !== selected)
      return;
    revealResultsFor.current = null;
    requestAnimationFrame(() => {
      const target = document.getElementById("plan-results");
      target?.scrollIntoView({
        behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches
          ? "auto"
          : "smooth",
        block: "start",
      });
      target?.focus({ preventScroll: true });
    });
  }, [plans, plansBusy, selected]);

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
    if (pathname !== "/destinations") {
      router.push(
        catalogDestinationHref(pathname, searchParams.toString(), code),
      );
      return;
    }
    revealResultsFor.current = code;
    if (code === selected && !plansBusy) {
      const target = document.getElementById("plan-results");
      target?.scrollIntoView?.({
        behavior: window.matchMedia?.("(prefers-reduced-motion: reduce)")
          .matches
          ? "auto"
          : "smooth",
        block: "start",
      });
      target?.focus({ preventScroll: true });
      revealResultsFor.current = null;
    }
    setSelected(code);
    setShowAllDestinations(false);
    router.replace(
      catalogDestinationHref(pathname, searchParams.toString(), code),
      { scroll: false },
    );
  };

  const focusPopularPlan = (plan: Plan) => selectDestination(plan.countryCode);

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
                  {plan.dataAllowance} · {plan.validityDays}{" "}
                  {plan.validityDays === 1 ? "day" : "days"}
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
                    {plan.validityDays}{" "}
                    {plan.validityDays === 1 ? "day" : "days"} ·{" "}
                    {npr(plan.sellingPriceNpr)}
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
        <div className="catalog-recovery" role="alert">
          <AlertTriangle size={20} />
          <div>
            <b>We couldn’t load the catalog</b>
            <p>{error}</p>
          </div>
          <button
            className="button secondary"
            disabled={countriesBusy || plansBusy}
            onClick={() => setAttempt((value) => value + 1)}
          >
            Try again
          </button>
        </div>
      ) : null}
      {coverageMessage && !plansBusy && !error ? (
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
      {countriesBusy || plansBusy || (!error && selected && plans === null) ? (
        <div
          className="catalog-loading"
          role="status"
          aria-label="Loading available plans"
        >
          <span>Finding available plans…</span>
          <div className="cards" aria-hidden="true">
            {[0, 1, 2].map((index) => (
              <div className="card catalog-placeholder" key={index}>
                <div className="skel" />
                <div className="skel" />
                <div className="skel" />
              </div>
            ))}
          </div>
        </div>
      ) : error ? null : !selected ? (
        <p className="catalog-empty">
          Select a destination above to see its available plans.
        </p>
      ) : visible.length ? (
        <div
          className="cards"
          id="plan-results"
          tabIndex={-1}
          aria-label={`Available plans for ${countryList.find((country) => country.code === selected)?.name ?? selected}`}
        >
          {visible.map((plan) => (
            <article className="card" key={plan.id}>
              {plan.popular ? <span className="badge">POPULAR</span> : null}
              <span className="flag">{flagEmoji(plan.countryCode)}</span>
              <h3>{plan.name}</h3>
              <p className="plan-meta">
                <MapPin size={13} style={{ verticalAlign: -2 }} />{" "}
                {plan.countryName} · <strong>{plan.dataAllowance}</strong> ·{" "}
                {plan.validityDays} {plan.validityDays === 1 ? "day" : "days"}
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
