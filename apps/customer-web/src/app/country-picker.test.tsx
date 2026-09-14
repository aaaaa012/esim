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
    fireEvent.click(
      screen.getByRole("button", { name: /select a destination/i }),
    );
    fireEvent.change(screen.getByPlaceholderText(/search countries/i), {
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
    fireEvent.click(
      screen.getByRole("button", { name: /select a destination/i }),
    );
    fireEvent.change(screen.getByPlaceholderText(/search countries/i), {
      target: { value: "India" },
    });
    expect(onChange).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("option", { name: /India/i }));
    expect(onChange).toHaveBeenCalledWith("IN");
  });
});
