import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import CountryPicker from "./country-picker";

afterEach(cleanup);

describe("CountryPicker", () => {
  it("keeps the destination menu open while a country name is typed", () => {
    const onChange = vi.fn();
    render(
      <CountryPicker
        countries={[
          { code: "IN", name: "India" },
          { code: "ID", name: "Indonesia" },
        ]}
        value=""
        onChange={onChange}
      />,
    );
    const search = screen.getByRole("combobox", { name: /choose your destination/i });
    fireEvent.focus(search);
    expect(screen.getAllByRole("combobox")).toHaveLength(1);
    fireEvent.change(search, {
      target: { value: "Ind" },
    });
    expect(screen.getByRole("listbox")).toBeDefined();
    expect(screen.getAllByRole("option")).toHaveLength(2);
    expect(onChange).not.toHaveBeenCalled();
  });

  it("does not select until the customer explicitly chooses a result", () => {
    const onChange = vi.fn();
    render(
      <CountryPicker
        countries={[{ code: "IN", name: "India" }]}
        value=""
        onChange={onChange}
      />,
    );
    const search = screen.getByRole("combobox", { name: /choose your destination/i });
    fireEvent.focus(search);
    fireEvent.change(search, {
      target: { value: "India" },
    });
    expect(onChange).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("option", { name: /India/i }));
    expect(onChange).toHaveBeenCalledWith("IN");
  });

  it("keeps search in the same field after a destination was selected", () => {
    render(
      <CountryPicker
        countries={[{ code: "IN", name: "India" }, { code: "FR", name: "France" }]}
        value="IN"
        onChange={vi.fn()}
      />,
    );
    const search = screen.getByRole("combobox", { name: /choose your destination/i }) as HTMLInputElement;
    expect(search.value).toBe("India");
    fireEvent.focus(search);
    expect(search.value).toBe("");
    fireEvent.change(search, { target: { value: "France" } });
    expect(screen.getAllByRole("combobox")).toHaveLength(1);
    expect(screen.getAllByRole("option")).toHaveLength(1);
    expect(screen.getByRole("option", { name: /France/i })).toBeDefined();
  });

  it("shows an empty state and lets Escape close the inline results", () => {
    render(
      <CountryPicker
        countries={[{ code: "IN", name: "India" }]}
        value=""
        onChange={vi.fn()}
      />,
    );
    const search = screen.getByRole("combobox", { name: /choose your destination/i });
    fireEvent.focus(search);
    fireEvent.change(search, { target: { value: "zzz" } });
    expect(screen.getByText(/No countries match/)).toBeDefined();
    fireEvent.keyDown(search, { key: "Escape" });
    expect(screen.queryByRole("listbox")).toBeNull();
  });
});
