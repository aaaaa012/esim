"use client";
import Link from "next/link";
import { useEffect, useState } from "react";
import { useSearchParams } from "next/navigation";
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

type Country = { code: string; name: string; popular?: boolean };

type Envelope<T> = {
  data: T;
  meta: { correlationId: string; timestamp: string };
};

function npr(amount: number) {
  return `NPR ${amount.toLocaleString("en-NP")}`;
}

export default function CatalogPlans() {
  const searchParams = useSearchParams();
  const targetEsimId = searchParams.get("esim") ?? "";
  const targetCountry = searchParams.get("country") ?? "";
  const [plans, setPlans] = useState<Plan[] | null>(null);
  const [countries, setCountries] = useState<Country[]>([]);
  const [selected, setSelected] = useState<string>("");
  const [coverage, setCoverage] = useState<Record<string, string>>({});
  const [plansBusy, setPlansBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [topUpMobile, setTopUpMobile] = useState("");
  const [topUpCountry, setTopUpCountry] = useState("");
  const [topUpToken, setTopUpToken] = useState("");
  const [showAllDestinations, setShowAllDestinations] = useState(false);

  useEffect(() => {
    try {
      setTopUpMobile(sessionStorage.getItem("vc_topup_mobile") ?? "");
      setTopUpCountry(sessionStorage.getItem("vc_topup_country") ?? "");
      setTopUpToken(sessionStorage.getItem("vc_topup_token") ?? "");
    } catch {
      setTopUpMobile("");
      setTopUpCountry("");
      setTopUpToken("");
    }
  }, []);

  useEffect(() => {
    if (targetCountry) setSelected(targetCountry);
  }, [targetCountry]);

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
        setPlans([]);
        setCountries(countriesData.data);
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
  }, []);

  // When a top-up lookup has pinned a destination, default to it so only that
  // country's plans are offered (the ones that can recharge the existing eSIM).
  useEffect(() => {
    if (
      topUpCountry &&
      countries.some((country) => country.code === topUpCountry)
    ) {
      setSelected(topUpCountry);
    }
  }, [topUpCountry, countries]);

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
  const visible = selected ? (grouped.get(selected) ?? []) : [];
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
  const popular = supported
    .filter((country) => popularCountries.has(country.code))
    .slice(0, 8);

  const selectDestination = (code: string) => {
    setSelected(code);
    setShowAllDestinations(false);
    requestAnimationFrame(() => {
      document
        .getElementById("plan-picker")
        ?.scrollIntoView({ behavior: "smooth", block: "center" });
    });
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
            <h3 id="supported-destinations-title">Where are you travelling?</h3>
            <p>
              Search all supported countries or jump to a popular destination.
            </p>
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
            disabled={!plans}
          />
          {plans ? (
            <small className="picker-help">
              Type a country name to quickly find your plan.
            </small>
          ) : null}
          {topUpMobile && selected && (
            <small className="topup-context">
              Recharging{" "}
              {selected
                ? (countryList.find((country) => country.code === selected)
                    ?.name ?? selected)
                : ""}{" "}
              for
              {` ${topUpMobile}`}.
            </small>
          )}
        </div>

        {!plans && !error ? (
          <div
            className="destination-grid popular-grid loading"
            aria-label="Loading popular destinations"
          >
            <span />
            <span />
            <span />
          </div>
        ) : popular.length ? (
          <div className="popular-destinations">
            <p className="destination-subtitle">Popular destinations</p>
            <div className="destination-grid popular-grid">
              {popular.map((country) => (
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
                  <span className="destination-label">
                    <b>{country.name}</b>
                    <small>View plans</small>
                  </span>
                  <span className="destination-arrow" aria-hidden="true">
                    →
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
      {error ? <ErrorModal error={error} onClose={() => setError(null)} /> : null}
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
        <div className="cards">
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
                  href={`/esim/checkout?plan=${plan.id}${topUpMobile ? `&mobile=${encodeURIComponent(topUpMobile)}&lookup=${encodeURIComponent(topUpToken)}&country=${encodeURIComponent(topUpCountry)}` : ""}${targetEsimId ? `&esim=${encodeURIComponent(targetEsimId)}&country=${encodeURIComponent(targetCountry)}` : ""}`}
                >
                  {topUpMobile ||
                  (targetEsimId && plan.countryCode === targetCountry)
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
