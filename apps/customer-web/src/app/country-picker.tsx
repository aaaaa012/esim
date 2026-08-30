"use client";
import { useEffect, useMemo, useRef, useState } from "react";
import { Check, ChevronDown, Globe2, Search } from "lucide-react";

export function flagEmoji(countryCode: string) {
  return countryCode
    .toUpperCase()
    .replace(/./g, (char) => String.fromCodePoint(127397 + char.charCodeAt(0)));
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
