import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { FonepayBankLogo } from "./fonepay-bank-logo";

describe("FonepayBankLogo", () => {
  it("keeps a bank initial visible until the remote logo loads", () => {
    render(
      <FonepayBankLogo
        name="Example Bank"
        src="https://bank.example/logo.png"
      />,
    );

    expect(screen.getByText("E")).toBeDefined();
    const image = screen.getByRole("img", { name: "Example Bank logo" });
    fireEvent.load(image);

    expect(screen.queryByText("E")).toBeNull();
    expect(image.className).toContain("loaded");
  });

  it("retains the fallback when a provider logo cannot load", () => {
    render(
      <FonepayBankLogo
        name="Unavailable Bank"
        src="http://bank.example/logo.png"
      />,
    );

    fireEvent.error(
      screen.getByRole("img", { name: "Unavailable Bank logo" }),
    );
    expect(screen.getByText("U")).toBeDefined();
    expect(screen.queryByRole("img")).toBeNull();
  });
});
