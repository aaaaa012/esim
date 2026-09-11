import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { FileUploader } from "./file-uploader";

describe("FileUploader", () => {
  it("accepts a selected file through the declared input contract", () => {
    const selected = vi.fn();
    const { container } = render(
      <FileUploader accept=".csv,.xlsx" onFileSelected={selected} />,
    );
    const input = container.querySelector(
      'input[type="file"]',
    ) as HTMLInputElement;
    const file = new File(["a,b"], "plans.csv", { type: "text/csv" });
    fireEvent.change(input, { target: { files: [file] } });
    expect(input.accept).toBe(".csv,.xlsx");
    expect(selected).toHaveBeenCalledWith(file);
  });

  it("accepts drag-and-drop when idle", () => {
    const selected = vi.fn();
    render(<FileUploader onFileSelected={selected} hint="CSV or Excel" />);
    const target = screen.getByRole("button", {
      name: /Click to choose a file or drag & drop/,
    });
    const file = new File(["content"], "inventory.csv", {
      type: "text/csv",
    });
    fireEvent.drop(target, { dataTransfer: { files: [file] } });
    expect(selected).toHaveBeenCalledWith(file);
  });

  it("shows file identity and removes it through an accessible action", () => {
    const selected = vi.fn();
    const file = new File([new Uint8Array(2048)], "inventory.xlsx");
    render(<FileUploader value={file} onFileSelected={selected} />);
    expect(screen.getByText("inventory.xlsx")).toBeTruthy();
    expect(screen.getByText("2.0 KB")).toBeTruthy();
    fireEvent.click(
      screen.getByRole("button", { name: "Remove inventory.xlsx" }),
    );
    expect(selected).toHaveBeenCalledWith(null);
  });

  it("locks selection and removal while an upload is active", () => {
    const selected = vi.fn();
    const file = new File(["content"], "plans.csv");
    const { rerender } = render(
      <FileUploader busy onFileSelected={selected} />,
    );
    const dropTarget = screen.getByRole("button", { name: /Uploading file/ });
    expect((dropTarget as HTMLButtonElement).disabled).toBe(true);
    fireEvent.drop(dropTarget, { dataTransfer: { files: [file] } });
    expect(selected).not.toHaveBeenCalled();

    rerender(<FileUploader busy value={file} onFileSelected={selected} />);
    expect(
      (
        screen.getByRole("button", {
          name: "Remove plans.csv",
        }) as HTMLButtonElement
      ).disabled,
    ).toBe(true);
  });
});
