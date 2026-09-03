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

function formatAllowance(mb: number) {
  return mb >= 1024 && mb % 1024 === 0 ? `${mb / 1024} GB` : `${mb} MB`;
}

function catalogAllowanceMb(plan: Plan) {
  if (typeof plan.allowanceMb === "number") return plan.allowanceMb;
  const normalized = plan.dataAllowance.trim().replace(/,/g, "");
  const match = normalized.match(/(\d+(?:\.\d+)?)\s*(KB|MB|GB|TB)\b/i);
  if (!match) return null;
  const amount = Number(match[1]);
  const unit = match[2]?.toUpperCase();
  return Math.round(
    amount *
      (unit === "TB"
        ? 1024 * 1024
        : unit === "GB"
          ? 1024
          : unit === "KB"
            ? 1 / 1024
            : 1),
  );
}

export function rankCatalogPlans(
  plans: Plan[],
  requestedMb?: number,
  requestedDays?: number,
) {
  const score = (plan: Plan) => {
    if (!requestedMb && !requestedDays)
      return [plan.popular ? 0 : 1, 0, plan.sellingPriceNpr];
    const allowanceMb = catalogAllowanceMb(plan);
    const knownAllowance = allowanceMb !== null;
    const dataGap = requestedMb
      ? knownAllowance
        ? allowanceMb! - requestedMb
        : Number.NEGATIVE_INFINITY
      : 0;
    const dayGap = requestedDays ? plan.validityDays - requestedDays : 0;
    const exact =
      (!requestedMb || dataGap === 0) && (!requestedDays || dayGap === 0);
    const sufficient =
      (!requestedMb || (knownAllowance && dataGap >= 0)) &&
      (!requestedDays || dayGap >= 0);
    const tier = exact ? 0 : sufficient ? 1 : 2;
    const shortfall =
      Math.abs(Math.min(dataGap, 0)) + Math.abs(Math.min(dayGap, 0)) * 1024;
    const surplus = Math.max(dataGap, 0) + Math.max(dayGap, 0) * 1024;
    return [tier, tier === 2 ? shortfall : surplus, plan.sellingPriceNpr];
  };
  return [...plans].sort((a, b) => {
    const left = score(a);
    const right = score(b);
    return left[0]! - right[0]! || left[1]! - right[1]! || left[2]! - right[2]!;
  });
}

function planPreferenceNote(
  plan: Plan,
  requestedMb?: number,
  requestedDays?: number,
) {
  const gaps: string[] = [];
  const allowanceMb = catalogAllowanceMb(plan);
  if (requestedMb && allowanceMb !== null && allowanceMb < requestedMb)
    gaps.push(`${formatAllowance(requestedMb - allowanceMb)} less data`);
  if (requestedMb && allowanceMb === null)
    gaps.push("data allowance could not be compared");
  if (requestedDays && plan.validityDays < requestedDays)
    gaps.push(`${requestedDays - plan.validityDays} fewer validity days`);
  return gaps.length ? gaps.join(" · ") : "Meets your preferences";
}

export default function CatalogPlans() {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const targetEsimId = searchParams.get("esim") ?? "";
  const targetCountry = searchParams.get("country") ?? "";
  const targetData = Number(searchParams.get("data") ?? "") || undefined;
  const targetDays = Number(searchParams.get("days") ?? "") || undefined;
  const [plans, setPlans] = useState<Plan[] | null>(null);
  const [countries, setCountries] = useState<Country[]>([]);
  const [selected, setSelected] = useState<string>("");
  const [selectedData, setSelectedData] = useState<number | undefined>(
    targetData,
  );
  const [selectedDays, setSelectedDays] = useState<number | undefined>(
    targetDays,
  );
  const [popularPlans, setPopularPlans] = useState<Plan[]>([]);
  const [coverage, setCoverage] = useState<Record<string, string>>({});
  const [plansBusy, setPlansBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showAllDestinations, setShowAllDestinations] = useState(false);

  useEffect(() => {
    if (targetCountry) setSelected(targetCountry.toUpperCase());
  }, [targetCountry]);

  useEffect(() => {
    setSelectedData(targetData);
  }, [targetData]);

  useEffect(() => {
    setSelectedDays(targetDays);
  }, [targetDays]);

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
          const allowances = new Set(
            plansData.data
              .map(catalogAllowanceMb)
              .filter((value): value is number => value !== null),
          );
          const durations = new Set(
            plansData.data.map((plan) => plan.validityDays),
          );
          setSelectedData((current) =>
            current && allowances.has(current) ? current : undefined,
          );
          setSelectedDays((current) =>
            current && durations.has(current) ? current : undefined,
          );
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
    if (selectedData) params.set("data", String(selectedData));
    else params.delete("data");
    if (selectedDays) params.set("days", String(selectedDays));
    else params.delete("days");
    const next = params.toString();
    if (next !== searchParams.toString())
      router.replace(`${pathname}${next ? `?${next}` : ""}`, { scroll: false });
  }, [pathname, router, searchParams, selected, selectedData, selectedDays]);

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
  const allowanceOptions = [
    ...new Set(
      destinationPlans
        .map(catalogAllowanceMb)
        .filter((value): value is number => value !== null),
    ),
  ].sort((a, b) => a - b);
  const durationOptions = [
    ...new Set(destinationPlans.map((plan) => plan.validityDays)),
  ].sort((a, b) => a - b);
  const visible = rankCatalogPlans(
    destinationPlans,
    selectedData,
    selectedDays,
  );
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
    setSelectedData(undefined);
    setSelectedDays(undefined);
    setShowAllDestinations(false);
    requestAnimationFrame(() => {
      document
        .getElementById("plan-picker")
        ?.scrollIntoView({ behavior: "smooth", block: "center" });
    });
  };

  const focusPopularPlan = (plan: Plan) => {
    setSelected(plan.countryCode);
    setSelectedData(catalogAllowanceMb(plan) ?? undefined);
    setSelectedDays(plan.validityDays);
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
            <p>Choose a destination, data allowance, and package validity.</p>
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

        {destinationPlans.length ? (
          <div className="plan-preferences" aria-label="Plan preferences">
            <div className="plan-preference-group">
              <div>
                <span>2</span>
                <p>
                  <b>How much data?</b>
                  <small>Choose an allowance</small>
                </p>
              </div>
              <div className="plan-filter-chips">
                <button
                  type="button"
                  className={!selectedData ? "selected" : ""}
                  aria-pressed={!selectedData}
                  onClick={() => setSelectedData(undefined)}
                >
                  Any data
                </button>
                {allowanceOptions.map((allowance) => (
                  <button
                    type="button"
                    key={allowance}
                    className={selectedData === allowance ? "selected" : ""}
                    aria-pressed={selectedData === allowance}
                    onClick={() => setSelectedData(allowance)}
                  >
                    {formatAllowance(allowance)}
                  </button>
                ))}
              </div>
            </div>
            <div className="plan-preference-group">
              <div>
                <span>3</span>
                <p>
                  <b>How long?</b>
                  <small>Select validity days</small>
                </p>
              </div>
              <div className="plan-filter-chips">
                <button
                  type="button"
                  className={!selectedDays ? "selected" : ""}
                  aria-pressed={!selectedDays}
                  onClick={() => setSelectedDays(undefined)}
                >
                  Any duration
                </button>
                {durationOptions.map((days) => (
                  <button
                    type="button"
                    key={days}
                    className={selectedDays === days ? "selected" : ""}
                    aria-pressed={selectedDays === days}
                    onClick={() => setSelectedDays(days)}
                  >
                    {days} days
                  </button>
                ))}
              </div>
            </div>
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
          {visible.map((plan, index) => (
            <article className="card" key={plan.id}>
              {index === 0 &&
              (selectedData || selectedDays) &&
              planPreferenceNote(plan, selectedData, selectedDays) ===
                "Meets your preferences" ? (
                <span className="badge">RECOMMENDED</span>
              ) : plan.popular ? (
                <span className="badge">POPULAR</span>
              ) : null}
              <span className="flag">{flagEmoji(plan.countryCode)}</span>
              <h3>{plan.name}</h3>
              <p className="plan-meta">
                <MapPin size={13} style={{ verticalAlign: -2 }} />{" "}
                {plan.countryName} · <strong>{plan.dataAllowance}</strong> ·{" "}
                {plan.validityDays} days
              </p>
              {selectedData || selectedDays ? (
                <p
                  className={`plan-match-note${
                    planPreferenceNote(plan, selectedData, selectedDays) ===
                    "Meets your preferences"
                      ? " match"
                      : " shortfall"
                  }`}
                >
                  {planPreferenceNote(plan, selectedData, selectedDays)}
                </p>
              ) : null}
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
