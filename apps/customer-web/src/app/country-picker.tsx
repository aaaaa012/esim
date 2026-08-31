"use client";
import { useEffect, useMemo, useRef, useState } from "react";
import { Check, ChevronDown, Globe2, Search } from "lucide-react";

const ALPHA3_TO_ALPHA2: Record<string, string> = {
  AFG: "af", ALB: "al", DZA: "dz", ASM: "as", AND: "ad", AGO: "ao", AIA: "ai", ATA: "aq",
  ATG: "ag", ARG: "ar", ARM: "am", ABW: "aw", AUS: "au", AUT: "at", AZE: "az", BHS: "bs",
  BHR: "bh", BGD: "bd", BRB: "bb", BLR: "by", BEL: "be", BLZ: "bz", BEN: "bj", BMU: "bm",
  BTN: "bt", BOL: "bo", BES: "bq", BIH: "ba", BWA: "bw", BVT: "bv", BRA: "br", IOT: "io",
  BRN: "bn", BGR: "bg", BFA: "bf", BDI: "bi", CPV: "cv", KHM: "kh", CMR: "cm", CAN: "ca",
  CYM: "ky", CAF: "cf", TCD: "td", CHL: "cl", CHN: "cn", CXR: "cx", CCK: "cc", COL: "co",
  COM: "km", COG: "cg", COD: "cd", COK: "ck", CRI: "cr", CIV: "ci", HRV: "hr", CUB: "cu",
  CUW: "cw", CYP: "cy", CZE: "cz", DNK: "dk", DJI: "dj", DMA: "dm", DOM: "do", ECU: "ec",
  EGY: "eg", SLV: "sv", GNQ: "gq", ERI: "er", EST: "ee", SWZ: "sz", ETH: "et", FLK: "fk",
  FRO: "fo", FJI: "fj", FIN: "fi", FRA: "fr", GUF: "gf", PYF: "pf", ATF: "tf", GAB: "ga",
  GMB: "gm", GEO: "ge", DEU: "de", GHA: "gh", GIB: "gi", GRC: "gr", GRL: "gl", GRD: "gd",
  GLP: "gp", GUM: "gu", GTM: "gt", GGY: "gg", GIN: "gn", GNB: "gw", GUY: "gy", HTI: "ht",
  HMD: "hm", VAT: "va", HND: "hn", HKG: "hk", HUN: "hu", ISL: "is", IND: "in", IDN: "id",
  IRN: "ir", IRQ: "iq", IRL: "ie", IMN: "im", ISR: "il", ITA: "it", JAM: "jm", JPN: "jp",
  JEY: "je", JOR: "jo", KAZ: "kz", KEN: "ke", KIR: "ki", PRK: "kp", KOR: "kr", KWT: "kw",
  KGZ: "kg", LAO: "la", LVA: "lv", LBN: "lb", LSO: "ls", LBR: "lr", LBY: "ly", LIE: "li",
  LTU: "lt", LUX: "lu", MAC: "mo", MKD: "mk", MDG: "mg", MWI: "mw", MYS: "my", MDV: "mv",
  MLI: "ml", MLT: "mt", MHL: "mh", MTQ: "mq", MRT: "mr", MUS: "mu", MYT: "yt", MEX: "mx",
  FSM: "fm", MDA: "md", MCO: "mc", MNG: "mn", MNE: "me", MSR: "ms", MAR: "ma", MOZ: "mz",
  MMR: "mm", NAM: "na", NRU: "nr", NPL: "np", NLD: "nl", NCL: "nc", NZL: "nz", NIC: "ni",
  NER: "ne", NGA: "ng", NIU: "nu", NFK: "nf", MNP: "mp", NOR: "no", OMN: "om", PAK: "pk",
  PLW: "pw", PSE: "ps", PAN: "pa", PNG: "pg", PRY: "py", PER: "pe", PHL: "ph", PCN: "pn",
  POL: "pl", PRT: "pt", PRI: "pr", QAT: "qa", REU: "re", ROU: "ro", RUS: "ru", RWA: "rw",
  BLM: "bl", SHN: "sh", KNA: "kn", LCA: "lc", MAF: "mf", SPM: "pm", VCT: "vc", WSM: "ws",
  SMR: "sm", STP: "st", SAU: "sa", SEN: "sn", SRB: "rs", SYC: "sc", SLE: "sl", SGP: "sg",
  SXM: "sx", SVK: "sk", SVN: "si", SLB: "sb", SOM: "so", ZAF: "za", SGS: "gs", SSD: "ss",
  ESP: "es", LKA: "lk", SDN: "sd", SUR: "sr", SJM: "sj", SWE: "se", CHE: "ch", SYR: "sy",
  TWN: "tw", TJK: "tj", TZA: "tz", THA: "th", TLS: "tl", TGO: "tg", KLN: "tk", TON: "to",
  TTO: "tt", TUN: "tn", TUR: "tr", TKM: "tm", TCA: "tc", TUV: "tv", UGA: "ug", UKR: "ua",
  ARE: "ae", GBR: "gb", USA: "us", UMI: "um", URY: "uy", UZB: "uz", VUT: "vu", VEN: "ve",
  VNM: "vn", VGB: "vg", VIR: "vi", WLF: "wf", ESH: "eh", YEM: "ye", ZMB: "zm", ZWE: "zw",
};

export function getIso2Code(countryCode?: string | null): string | null {
  if (!countryCode) return null;
  const clean = countryCode.trim().toUpperCase();
  if (clean.length === 2) return clean.toLowerCase();
  if (clean.length === 3 && ALPHA3_TO_ALPHA2[clean]) return ALPHA3_TO_ALPHA2[clean];
  return null;
}

export function CountryFlag({
  code,
  alt,
  className = "",
}: {
  code?: string | null;
  alt?: string;
  className?: string;
}) {
  const [failed, setFailed] = useState(false);
  const iso2 = getIso2Code(code);

  if (!iso2 || failed) {
    return (
      <span className={`country-flag-fallback ${className}`} aria-label={alt || code || "Flag"}>
        {code && code.length <= 3 ? code.toUpperCase() : <Globe2 size={16} />}
      </span>
    );
  }

  return (
    <img
      src={`https://flagcdn.com/w40/${iso2}.png`}
      srcSet={`https://flagcdn.com/w80/${iso2}.png 2x`}
      alt={alt || code || "Country flag"}
      className={`country-flag-img ${className}`}
      loading="lazy"
      onError={() => setFailed(true)}
    />
  );
}

export function flagEmoji(countryCode?: string | null) {
  return countryCode ? (
    <CountryFlag code={countryCode} />
  ) : (
    <span className="country-flag-fallback">
      <Globe2 size={16} />
    </span>
  );
}

type Country = { code: string; name: string };

export default function CountryPicker({
  countries,
  value,
  onChange,
  disabled = false,
}: {
  countries: Country[];
  value: string;
  onChange: (code: string) => void;
  disabled?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const rootRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  const label = useMemo(
    () => countries.find((country) => country.code === value)?.name ?? "",
    [countries, value],
  );

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return countries;
    return countries.filter((country) =>
      country.name.toLowerCase().includes(q),
    );
  }, [countries, query]);

  useEffect(() => {
    const onPointerDown = (event: MouseEvent | TouchEvent) => {
      if (rootRef.current && !rootRef.current.contains(event.target as Node)) {
        setOpen(false);
      }
    };
    document.addEventListener("mousedown", onPointerDown);
    document.addEventListener("touchstart", onPointerDown);
    return () => {
      document.removeEventListener("mousedown", onPointerDown);
      document.removeEventListener("touchstart", onPointerDown);
    };
  }, []);

  useEffect(() => {
    if (open) {
      setQuery("");
      setActive(
        Math.max(
          0,
          filtered.findIndex((country) => country.code === value),
        ),
      );
      const frame = requestAnimationFrame(() => inputRef.current?.focus());
      return () => cancelAnimationFrame(frame);
    }
  }, [open]);

  useEffect(() => {
    const current = listRef.current?.querySelector('[data-active="true"]');
    current?.scrollIntoView({ block: "nearest" });
  }, [active]);

  const select = (code: string) => {
    onChange(code);
    setOpen(false);
  };

  const onKeyDown = (event: React.KeyboardEvent) => {
    if (event.key === "ArrowDown") {
      event.preventDefault();
      setActive((index) => Math.min(index + 1, filtered.length - 1));
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      setActive((index) => Math.max(index - 1, 0));
    } else if (event.key === "Enter") {
      event.preventDefault();
      const country = filtered[active];
      if (country) select(country.code);
    } else if (event.key === "Escape") {
      setOpen(false);
    }
  };

  return (
    <div className="country-picker" ref={rootRef}>
      <label htmlFor="country-picker-input">Choose your destination</label>
      <button
        type="button"
        className="country-picker-trigger"
        aria-haspopup="listbox"
        aria-expanded={open}
        disabled={disabled}
        onClick={() => setOpen((current) => !current)}
      >
        <span className="country-picker-value">
          {value ? (
            <>
              <span className="cp-flag">{flagEmoji(value)}</span>
              <span className="cp-selected-name">{label || value}</span>
            </>
          ) : (
            <>
              <Globe2 size={18} />
              <span>Select a destination…</span>
            </>
          )}
        </span>
        <ChevronDown
          size={18}
          className={`cp-chevron${open ? " is-open" : ""}`}
        />
      </button>
      {open && (
        <div
          className="country-picker-menu"
          role="listbox"
          onKeyDown={onKeyDown}
        >
          <div className="country-picker-search">
            <Search size={16} />
            <input
              id="country-picker-input"
              ref={inputRef}
              value={query}
              placeholder="Search countries…"
              onChange={(event) => {
                setQuery(event.target.value);
                setActive(0);
              }}
            />
          </div>
          <div className="country-picker-options" ref={listRef}>
            {filtered.length ? (
              filtered.map((country, index) => (
                <button
                  type="button"
                  role="option"
                  aria-selected={country.code === value}
                  data-active={index === active}
                  key={country.code}
                  className={`country-picker-option${country.code === value ? " is-selected" : ""}`}
                  onMouseEnter={() => setActive(index)}
                  onClick={() => select(country.code)}
                >
                  <span className="cp-flag">{flagEmoji(country.code)}</span>
                  <span className="cp-name">{country.name}</span>
                  {country.code === value && <Check size={16} />}
                </button>
              ))
            ) : (
              <p className="country-picker-empty">
                No countries match “{query}”.
              </p>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
