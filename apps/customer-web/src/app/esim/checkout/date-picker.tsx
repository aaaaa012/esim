"use client";

import { CalendarDays, ChevronLeft, ChevronRight } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";

type DatePickerProps = {
  name: string;
  value: string;
  onChange: (value: string) => void;
  min?: string;
  max?: string;
  placeholder?: string;
};

const months = new Intl.DateTimeFormat("en", { month: "long" });
const displayDate = new Intl.DateTimeFormat("en-NP", {
  day: "numeric",
  month: "short",
  year: "numeric",
});

function parse(value?: string) {
  if (!value) return null;
  const [year, month, day] = value.split("-").map(Number);
  if (!year || !month || !day) return null;
  return new Date(year, month - 1, day);
}

function iso(date: Date) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

export default function DatePicker({
  name,
  value,
  onChange,
  min,
  max,
  placeholder = "Select date",
}: DatePickerProps) {
  const selected = parse(value);
  const minDate = parse(min);
  const maxDate = parse(max);
  const initial = selected ?? maxDate ?? minDate ?? new Date();
  const [open, setOpen] = useState(false);
  const [mobile, setMobile] = useState(false);
  const [view, setView] = useState(
    () => new Date(initial.getFullYear(), initial.getMonth(), 1),
  );
  const root = useRef<HTMLDivElement>(null);
  const popover = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const panel = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const close = (event: PointerEvent) => {
      if (
        !root.current?.contains(event.target as Node) &&
        !popover.current?.contains(event.target as Node)
      )
        setOpen(false);
    };
    document.addEventListener("pointerdown", close);
    return () => document.removeEventListener("pointerdown", close);
  }, []);

  useEffect(() => {
    if (!open || !mobile) return;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    popover.current?.focus();
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
      if (event.key !== "Tab") return;
      const controls = panel.current?.querySelectorAll<HTMLElement>(
        "button:not(:disabled), select:not(:disabled)",
      );
      if (!controls?.length) return;
      const first = controls[0];
      const last = controls[controls.length - 1];
      if (
        event.shiftKey &&
        (document.activeElement === first ||
          document.activeElement === popover.current)
      ) {
        event.preventDefault();
        last?.focus();
      } else if (
        !event.shiftKey &&
        (document.activeElement === last ||
          document.activeElement === popover.current)
      ) {
        event.preventDefault();
        first?.focus();
      }
    };
    document.addEventListener("keydown", closeOnEscape);
    return () => {
      document.body.style.overflow = previousOverflow;
      document.removeEventListener("keydown", closeOnEscape);
      trigger.current?.focus();
    };
  }, [open, mobile]);

  const years = useMemo(() => {
    const lower = minDate?.getFullYear() ?? new Date().getFullYear() - 120;
    const upper = maxDate?.getFullYear() ?? new Date().getFullYear() + 20;
    return Array.from(
      { length: upper - lower + 1 },
      (_, index) => upper - index,
    );
  }, [min, max]);

  const start = new Date(view.getFullYear(), view.getMonth(), 1);
  const gridStart = new Date(start);
  gridStart.setDate(start.getDate() - start.getDay());
  const days = Array.from({ length: 42 }, (_, index) => {
    const date = new Date(gridStart);
    date.setDate(gridStart.getDate() + index);
    return date;
  });
  const disabled = (date: Date) =>
    Boolean((minDate && date < minDate) || (maxDate && date > maxDate));

  return (
    <div className="date-picker" ref={root}>
      <button
        ref={trigger}
        type="button"
        name={name}
        className={`date-picker-trigger${value ? " has-value" : ""}`}
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={() => {
          setMobile(window.matchMedia("(max-width: 700px)").matches);
          setOpen((current) => !current);
        }}
      >
        <span>{selected ? displayDate.format(selected) : placeholder}</span>
        <CalendarDays size={18} />
      </button>
      {open &&
        mobile &&
        createPortal(
          <div
            className="date-picker-backdrop"
            onPointerDown={() => setOpen(false)}
          >
            <div
              ref={panel}
              tabIndex={-1}
              className="date-picker-mobile-panel"
              onPointerDown={(event) => event.stopPropagation()}
            >
              <div className="date-picker-mobile-heading">
                <strong>Choose {name}</strong>
                <button
                  type="button"
                  onClick={() => setOpen(false)}
                  aria-label="Close calendar"
                >
                  Close
                </button>
              </div>
              {calendar()}
            </div>
          </div>,
          document.body,
        )}
      {open && !mobile && calendar()}
    </div>
  );

  function calendar() {
    return (
      <div
        className="date-picker-popover"
        role="dialog"
        aria-label={`Choose ${name}`}
        ref={popover}
        tabIndex={-1}
      >
        <div className="date-picker-nav">
          <button
            type="button"
            aria-label="Previous month"
            onClick={() =>
              setView(new Date(view.getFullYear(), view.getMonth() - 1, 1))
            }
          >
            <ChevronLeft size={18} />
          </button>
          <div>
            <select
              aria-label="Month"
              value={view.getMonth()}
              onChange={(event) =>
                setView(
                  new Date(view.getFullYear(), Number(event.target.value), 1),
                )
              }
            >
              {Array.from({ length: 12 }, (_, month) => (
                <option value={month} key={month}>
                  {months.format(new Date(2024, month, 1))}
                </option>
              ))}
            </select>
            <select
              aria-label="Year"
              value={view.getFullYear()}
              onChange={(event) =>
                setView(
                  new Date(Number(event.target.value), view.getMonth(), 1),
                )
              }
            >
              {years.map((year) => (
                <option value={year} key={year}>
                  {year}
                </option>
              ))}
            </select>
          </div>
          <button
            type="button"
            aria-label="Next month"
            onClick={() =>
              setView(new Date(view.getFullYear(), view.getMonth() + 1, 1))
            }
          >
            <ChevronRight size={18} />
          </button>
        </div>
        <div className="date-picker-weekdays" aria-hidden="true">
          {["Su", "Mo", "Tu", "We", "Th", "Fr", "Sa"].map((day) => (
            <span key={day}>{day}</span>
          ))}
        </div>
        <div className="date-picker-days">
          {days.map((date) => {
            const dateValue = iso(date);
            const isSelected = value === dateValue;
            return (
              <button
                type="button"
                key={dateValue}
                disabled={disabled(date)}
                className={`${date.getMonth() !== view.getMonth() ? "outside " : ""}${isSelected ? "selected" : ""}`}
                aria-pressed={isSelected}
                onClick={() => {
                  onChange(dateValue);
                  setOpen(false);
                }}
              >
                {date.getDate()}
              </button>
            );
          })}
        </div>
        <div className="date-picker-footer">
          {value && (
            <button type="button" onClick={() => onChange("")}>
              Clear
            </button>
          )}
          <span>
            {selected ? displayDate.format(selected) : "Choose a date"}
          </span>
        </div>
      </div>
    );
  }
}
