import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

type DataTableProps = {
  columns: { id: string; label: string; className?: string }[];
  rows: ReactNode[][];
  rowKey: (row: ReactNode[]) => string;
  className?: string;
};

export function DataTable({ columns, rows, rowKey, className }: DataTableProps) {
  return (
    <div className={cn("ops-data-table overflow-x-auto", className)}>
      <table className="w-full text-left text-sm">
        <thead>
          <tr className="border-b">
            {columns.map((column) => (
              <th
                key={column.id}
                className={cn(
                  "h-10 px-3 text-xs font-medium text-muted-foreground whitespace-nowrap",
                  column.className,
                )}
              >
                {column.label}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr
              key={rowKey(row)}
              className="border-b transition-colors last:border-0 hover:bg-primary/[0.035]"
            >
              {row.map((cell, index) => (
                <td
                  key={index}
                  className={cn(
                    "px-3 py-3 align-middle whitespace-nowrap",
                    columns[index]?.className,
                  )}
                >
                  {cell}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
