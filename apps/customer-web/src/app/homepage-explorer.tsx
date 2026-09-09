"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import {
  ArrowRight,
  RefreshCw,
  Smartphone,
} from "lucide-react";
import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import CountryPicker, { flagEmoji } from "./country-picker";
import { formatPlanDataText } from "../lib/format-data";

const API = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:4000/api/v1";

type Country = { code: string; name: string; popular?: boolean };
type Plan = {
  id: string;
  countryCode: string;
  countryName: string;
  name: string;
  dataAllowance: string;
  validityDays: number;
  sellingPriceNpr: number;
  popular: boolean;
};
type Envelope<T> = { data: T };
type ExplorerState = {
  countries: Country[];
  popularPlans: Plan[];
  loading: boolean;
  error: boolean;
  retry: () => void;
};

const ExplorerContext = createContext<ExplorerState | null>(null);

function useHomepageExplorer() {
  const value = useContext(ExplorerContext);
  if (!value) throw new Error("Homepage explorer requires its provider");
  return value;
}

export function HomepageExplorerProvider({ children }: { children: ReactNode }) {
  const [countries, setCountries] = useState<Country[]>([]);
  const [popularPlans, setPopularPlans] = useState<Plan[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    setError(false);
    Promise.all([
      fetch(`${API}/public/countries`, { signal: controller.signal }),
      fetch(`${API}/public/plans?popular=true&limit=6`, {
        signal: controller.signal,
      }),
    ])
      .then(async ([countriesResponse, plansResponse]) => {
        if (!countriesResponse.ok || !plansResponse.ok) throw new Error();
        const [countryData, planData] = (await Promise.all([
          countriesResponse.json(),
          plansResponse.json(),
        ])) as [Envelope<Country[]>, Envelope<Plan[]>];
        setCountries(countryData.data);
        setPopularPlans(planData.data.filter((plan) => plan.popular).slice(0, 6));
      })
      .catch((reason: unknown) => {
        if (!(reason instanceof DOMException && reason.name === "AbortError")) {
          setCountries([]);
          setPopularPlans([]);
          setError(true);
        }
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [attempt]);

  return (
    <ExplorerContext.Provider
      value={{
        countries,
        popularPlans,
        loading,
        error,
        retry: () => setAttempt((value) => value + 1),
      }}
    >
      {children}
    </ExplorerContext.Provider>
  );
}

export function HeroDestinationSearch() {
  const router = useRouter();
  const { countries, loading, error, retry } = useHomepageExplorer();
  const [selected, setSelected] = useState("");
  const popular = useMemo(
    () => countries.filter((country) => country.popular).slice(0, 5),
    [countries],
  );
  const exploreHref = selected
    ? `/destinations?country=${encodeURIComponent(selected)}`
    : "/destinations";

  return (
    <div className="hero-discovery" aria-label="Find a travel eSIM plan">
      <CountryPicker
        countries={countries}
        value={selected}
        onChange={setSelected}
        disabled={loading || error}
        label="Where are you headed?"
        placeholder={loading ? "Loading destinations…" : "Search destination"}
        searchPlaceholder="Search destinations…"
      />
      {popular.length ? (
        <div className="hero-popular" aria-label="Popular destinations">
          {popular.map((country) => (
            <button
              type="button"
              key={country.code}
              onClick={() =>
                router.push(`/destinations?country=${encodeURIComponent(country.code)}`)
              }
            >
              {flagEmoji(country.code)} <span>{country.name}</span>
            </button>
          ))}
        </div>
      ) : null}
      {error ? (
        <button type="button" className="hero-catalog-retry" onClick={retry}>
          <RefreshCw size={15} /> Destinations unavailable. Try again
        </button>
      ) : null}
      <Link className="button hero-explore-button" href={exploreHref}>
        Explore eSIM plans <ArrowRight size={17} />
      </Link>
      <div className="hero-utility-links">
        <span>
          Already have an eSIM? <Link href="/recharge">Recharge</Link>
        </span>
        <span>
          <Smartphone size={14} /> Not sure about your phone?{" "}
          <Link href="/compatibility">Check compatibility</Link>
        </span>
      </div>
    </div>
  );
}

function npr(amount: number) {
  return `NPR ${amount.toLocaleString("en-NP")}`;
}

export function PopularRightNow() {
  const { popularPlans, loading } = useHomepageExplorer();
  if (!loading && !popularPlans.length) return null;

  return (
    <section className="homepage-popular section" aria-labelledby="popular-now-title">
      <div className="shell">
        <div className="homepage-popular-heading">
          <span>Popular right now</span>
          <h2 id="popular-now-title">Traveller favourites</h2>
        </div>
        <div className="homepage-popular-rail" aria-busy={loading}>
          {loading
            ? [0, 1, 2].map((item) => (
                <div className="homepage-plan-card is-loading" key={item} />
              ))
            : popularPlans.map((plan) => (
                <article className="homepage-plan-card" key={plan.id}>
                  <div className="homepage-plan-country">
                    <span>{flagEmoji(plan.countryCode)}</span>
                    <small>{plan.countryName}</small>
                  </div>
                  <h3>{plan.name}</h3>
                  <p>
                    {formatPlanDataText(plan.dataAllowance)} · {plan.validityDays}{" "}
                    {plan.validityDays === 1 ? "day" : "days"}
                  </p>
                  <div>
                    <b>{npr(plan.sellingPriceNpr)}</b>
                    <Link href={`/destinations?country=${plan.countryCode}`}>
                      View plan <ArrowRight size={15} />
                    </Link>
                  </div>
                </article>
              ))}
        </div>
      </div>
    </section>
  );
}
