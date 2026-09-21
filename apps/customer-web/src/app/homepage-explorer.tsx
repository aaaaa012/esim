"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import {
  ArrowLeft,
  ArrowRight,
  CreditCard,
  Pause,
  Play,
  RefreshCw,
  Smartphone,
} from "lucide-react";
import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import CountryPicker, { flagEmoji } from "./country-picker";
import { formatPlanDataText } from "../lib/format-data";

const API = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:4000/api/v1";

const HERO_FALLBACK_COUNTRIES: Country[] = [
  { code: "AU", name: "Australia", popular: true },
  { code: "CA", name: "Canada", popular: true },
  { code: "FR", name: "France", popular: true },
  { code: "DE", name: "Germany", popular: true },
];

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
type FeaturedPlan = { plan: Plan };
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

export function HomepageExplorerProvider({
  children,
}: {
  children: ReactNode;
}) {
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
      fetch(`${API}/public/homepage-featured-plans`, {
        signal: controller.signal,
      }),
    ])
      .then(async ([countriesResponse, plansResponse]) => {
        if (!countriesResponse.ok || !plansResponse.ok) throw new Error();
        const [countryData, planData] = (await Promise.all([
          countriesResponse.json(),
          plansResponse.json(),
        ])) as [Envelope<Country[]>, Envelope<FeaturedPlan[]>];
        let homepagePlans = planData.data
          .map((feature) => feature?.plan)
          .filter((plan): plan is Plan => Boolean(plan));
        if (!homepagePlans.length) {
          try {
            for (const path of [
              "/public/plans?popular=true&limit=12",
              "/public/plans?limit=12",
            ]) {
              const fallbackResponse = await fetch(`${API}${path}`, {
                signal: controller.signal,
              });
              if (!fallbackResponse.ok) continue;
              const fallbackData =
                (await fallbackResponse.json()) as Envelope<Plan[]>;
              homepagePlans = fallbackData.data;
              if (homepagePlans.length) break;
            }
          } catch {
            // The curated feed remains authoritative; an unavailable legacy
            // fallback should not prevent destinations from loading.
          }
        }
        setCountries(countryData.data);
        setPopularPlans(homepagePlans.slice(0, 24));
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
  const availableCountries = countries.length
    ? countries
    : HERO_FALLBACK_COUNTRIES;
  const popular = useMemo(
    () => availableCountries.filter((country) => country.popular).slice(0, 5),
    [availableCountries],
  );
  const exploreHref = selected
    ? `/destinations?country=${encodeURIComponent(selected)}`
    : "/destinations";

  return (
    <div
      id="explore"
      className="hero-discovery"
      role="region"
      aria-label="Find a travel eSIM plan"
      tabIndex={-1}
    >
      <CountryPicker
        countries={availableCountries}
        value={selected}
        onChange={setSelected}
        disabled={loading && countries.length === 0}
        label="Where are you headed?"
        placeholder={loading ? "Loading destinations…" : "Search destination"}
        searchPlaceholder="Search destinations…"
        triggerIcon="search"
      />
      {popular.length ? (
        <div className="hero-popular-block">
          <span className="hero-popular-label">Popular destinations</span>
          <div className="hero-popular" aria-label="Popular destinations">
            {popular.map((country) => (
              <button
                type="button"
                key={country.code}
                onClick={() =>
                  router.push(
                    `/destinations?country=${encodeURIComponent(country.code)}`,
                  )
                }
              >
                {flagEmoji(country.code)} <span>{country.name}</span>
              </button>
            ))}
          </div>
        </div>
      ) : null}
      {error && availableCountries.length === 0 ? (
        <button type="button" className="hero-catalog-retry" onClick={retry}>
          <RefreshCw size={15} /> Destinations unavailable. Try again
        </button>
      ) : null}
      <Link className="button hero-explore-button" href={exploreHref}>
        Explore eSIM plans <ArrowRight size={17} />
      </Link>
      <div className="hero-utility-links">
        <span>
          <CreditCard className="mobile-utility-icon" size={14} /> Already have
          an eSIM?{" "}
          <Link href="/recharge">
            Recharge <ArrowRight size={14} />
          </Link>
        </span>
        <span>
          <Smartphone size={14} /> Not sure about your phone?{" "}
          <Link href="/compatibility">
            Check compatibility <ArrowRight size={14} />
          </Link>
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
  const railRef = useRef<HTMLDivElement>(null);
  const interactionPaused = useRef(false);
  const [paused, setPaused] = useState(false);
  const [announcement, setAnnouncement] = useState("");
  const canRotate = popularPlans.length > 3;
  const move = (direction: -1 | 1, announce = true) => {
    const rail = railRef.current;
    const card = rail?.querySelector<HTMLElement>(".homepage-plan-card");
    if (!rail || !card) return;
    const distance = card.getBoundingClientRect().width + 14;
    const requested = rail.scrollLeft + direction * distance;
    const max = rail.scrollWidth - rail.clientWidth;
    rail.scrollTo({
      left: requested > max - 2 ? 0 : Math.max(0, requested),
      behavior: "smooth",
    });
    if (announce)
      setAnnouncement(
        direction > 0
          ? "Showing later recommendations"
          : "Showing earlier recommendations",
      );
  };
  useEffect(() => {
    if (
      !canRotate ||
      paused ||
      window.matchMedia("(prefers-reduced-motion: reduce)").matches
    )
      return;
    const timer = window.setInterval(() => {
      if (!interactionPaused.current && document.visibilityState === "visible")
        move(1, false);
    }, 7000);
    return () => window.clearInterval(timer);
  }, [canRotate, paused, popularPlans.length]);
  if (!loading && !popularPlans.length) return null;

  return (
    <section
      className="homepage-popular section"
      aria-labelledby="popular-now-title"
    >
      <div className="shell">
        <div className="homepage-popular-heading">
          <div>
            <span>Recommended for your next trip</span>
            <h2 id="popular-now-title">Traveller favourites</h2>
          </div>
          {canRotate ? (
            <div
              className="homepage-popular-controls"
              aria-label="Traveller favourites controls"
            >
              <button
                type="button"
                aria-label="Previous recommendations"
                onClick={() => move(-1)}
              >
                <ArrowLeft size={17} />
              </button>
              <button
                type="button"
                aria-label="Next recommendations"
                onClick={() => move(1)}
              >
                <ArrowRight size={17} />
              </button>
              <button
                type="button"
                aria-pressed={paused}
                onClick={() => setPaused((value) => !value)}
              >
                {paused ? <Play size={16} /> : <Pause size={16} />}
                <span>{paused ? "Play" : "Pause"}</span>
              </button>
            </div>
          ) : null}
        </div>
        <p className="sr-only" aria-live="polite">
          {announcement}
        </p>
        <div
          className="homepage-popular-rail"
          ref={railRef}
          aria-busy={loading}
          onMouseEnter={() => (interactionPaused.current = true)}
          onMouseLeave={() => (interactionPaused.current = false)}
          onFocusCapture={() => (interactionPaused.current = true)}
          onBlurCapture={() => (interactionPaused.current = false)}
          onPointerDown={() => (interactionPaused.current = true)}
          onPointerUp={() => (interactionPaused.current = false)}
        >
          {loading
            ? [0, 1, 2].map((item) => (
                <div className="homepage-plan-card is-loading" key={item} />
              ))
            : popularPlans.map((plan) => (
                <Link
                  className="homepage-plan-card"
                  href={`/destinations?country=${plan.countryCode}`}
                  aria-label={`View ${plan.countryName} plans`}
                  key={plan.id}
                >
                  <div className="homepage-plan-country">
                    <span>{flagEmoji(plan.countryCode)}</span>
                    <small>{plan.countryName}</small>
                  </div>
                  <h3>{plan.countryName}</h3>
                  <p>
                    {formatPlanDataText(plan.dataAllowance)} ·{" "}
                    {plan.validityDays}{" "}
                    {plan.validityDays === 1 ? "day" : "days"}
                  </p>
                  <div>
                    <b>{npr(plan.sellingPriceNpr)}</b>
                    <span className="homepage-plan-link">
                      View plans <ArrowRight size={15} />
                    </span>
                  </div>
                </Link>
              ))}
        </div>
      </div>
    </section>
  );
}
