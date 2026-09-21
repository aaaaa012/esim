"use client";
import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import {
  ArrowRight,
  AlertTriangle,
  CalendarDays,
  CheckCircle2,
  Globe2,
  MapPin,
  Signal,
} from "lucide-react";
import CountryPicker from "./country-picker";
import { formatPlanDataText } from "../lib/format-data";

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
  return "";
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
  const [coverage, setCoverage] = useState<Record<string, string>>({});
  const [attempt, setAttempt] = useState(0);
  const [countriesBusy, setCountriesBusy] = useState(true);
  const [plansBusy, setPlansBusy] = useState(false);
  const [countriesError, setCountriesError] = useState<string | null>(null);
  const [plansError, setPlansError] = useState<string | null>(null);
  const error = countriesError || plansError;
  const revealResultsFor = useRef<string | null>(null);

  useEffect(() => {
    if (targetCountry) setSelected(targetCountry.toUpperCase());
  }, [targetCountry]);

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
      const prefersReducedMotion =
        typeof window.matchMedia === "function" &&
        window.matchMedia("(prefers-reduced-motion: reduce)").matches;
      target?.scrollIntoView({
        behavior: prefersReducedMotion ? "auto" : "smooth",
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
    router.replace(
      catalogDestinationHref(pathname, searchParams.toString(), code),
      { scroll: false },
    );
  };

  return (
    <>
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

        {!countriesBusy && !error && !supported.length ? (
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
        <section className="plan-results-section">
          <div className="plan-results-heading">
            <span>Choose plan</span>
            <h2>
              Best plans for{" "}
              {countryList.find((country) => country.code === selected)?.name ??
                selected}
            </h2>
            <p>Compare live plan allowances, validity, and NPR prices.</p>
          </div>
          <div
            className="cards"
            id="plan-results"
            tabIndex={-1}
            aria-label={`Available plans for ${countryList.find((country) => country.code === selected)?.name ?? selected}`}
          >
            {visible.map((plan) => (
              <article className="card catalog-plan-card" key={plan.id}>
                {plan.popular ? (
                  <span className="badge">Most popular</span>
                ) : null}
                <div className="catalog-plan-main">
                  <span className="catalog-plan-icon">
                    <Signal aria-hidden="true" />
                  </span>
                  <div>
                    <h3>{plan.name}</h3>
                    <p>
                      {formatPlanDataText(plan.dataAllowance)} ·{" "}
                      {plan.validityDays}{" "}
                      {plan.validityDays === 1 ? "day" : "days"}
                    </p>
                  </div>
                  <b>{npr(plan.sellingPriceNpr)}</b>
                </div>
                <div className="catalog-plan-facts">
                  <span>
                    <MapPin aria-hidden="true" />
                    <small>Destination</small>
                    <b>{plan.countryName}</b>
                  </span>
                  <span>
                    <Signal aria-hidden="true" />
                    <small>Allowance</small>
                    <b>{formatPlanDataText(plan.dataAllowance)}</b>
                  </span>
                  <span>
                    <CalendarDays aria-hidden="true" />
                    <small>Validity</small>
                    <b>
                      {plan.validityDays}{" "}
                      {plan.validityDays === 1 ? "day" : "days"}
                    </b>
                  </span>
                </div>
                <Link
                  className="button catalog-plan-select"
                  href={`/esim/checkout?plan=${plan.id}${targetEsimId ? `&esim=${encodeURIComponent(targetEsimId)}&country=${encodeURIComponent(targetCountry)}` : ""}`}
                >
                  {targetEsimId && plan.countryCode === targetCountry
                    ? "Recharge"
                    : "Select plan"}{" "}
                  <ArrowRight aria-hidden="true" />
                </Link>
              </article>
            ))}
          </div>
        </section>
      ) : (
        <p className="catalog-empty">
          No plans available for this destination yet.
        </p>
      )}
    </>
  );
}
