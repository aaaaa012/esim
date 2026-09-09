import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { Button } from "./button";
import { Table, TableBody, TableCell, TableRow } from "./table";

describe("responsive operation controls", () => {
  it("keeps action labels intact when a table must scroll", () => {
    render(
      <Table>
        <TableBody>
          <TableRow>
            <TableCell>
              <Button>Apply</Button>
            </TableCell>
          </TableRow>
        </TableBody>
      </Table>,
    );

    const action = screen.getByRole("button", { name: "Apply" });
    expect(action.textContent).toBe("Apply");
    expect(action.closest("table")?.className).toContain(
      "[&_button]:whitespace-nowrap",
    );
  });
});
