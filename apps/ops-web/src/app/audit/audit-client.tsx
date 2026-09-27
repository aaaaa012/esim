"use client";
import { useAuthenticatedFetch } from "../authenticated-api-provider";
import { useEffect, useMemo, useState } from "react";
import { Download } from "lucide-react";
import { PageHeader } from "@/components/page-header";
import { Panel } from "@/components/panel";
import { StatusBadge } from "@/components/status-badge";
import { SearchInput } from "@/components/search-input";
import { EmptyState } from "@/components/empty-state";
import { Button } from "@/components/ui/button";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { downloadCsv } from "@/lib/csv";
import { cn } from "@/lib/utils";
import { PaginationBar } from "@/components/pagination-bar";

const API = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:4000/api/v1";
const PAGE_SIZE = 50;
type Audit = {
  id: string;
  module: string;
  entity: string;
  entityId: string;
  action: string;
  performedByEmail: string | null;
  previousValue: unknown;
  newValue: unknown;
  createdAt: string;
};

const detailOf = (value: unknown) => {
  if (value === null || value === undefined) return "—";
  if (typeof value === "string") return value;
  if (typeof value === "object") return JSON.stringify(value);
  return String(value);
};

const ACTION_TONE: Record<string, string> = {
  create: "text-sky-600",
  approve: "text-emerald-600",
  activate: "text-emerald-600",
  complete: "text-emerald-600",
  verified: "text-emerald-600",
  update: "text-amber-600",
  export: "text-violet-600",
  revoke: "text-red-600",
  cancel: "text-red-600",
  reject: "text-red-600",
  disable: "text-red-600",
  fail: "text-red-600",
};
const actionTone = (action: string) =>
  ACTION_TONE[action.toLowerCase()] ??
  Object.entries(ACTION_TONE).find(([key]) =>
    action.toLowerCase().startsWith(key),
  )?.[1] ??
  "text-muted-foreground";

export default function AuditClient() {
  const authFetch = useAuthenticatedFetch();
  const [items, setItems] = useState<Audit[]>([]);
  const [loading, setLoading] = useState(true);
  const [query, setQuery] = useState("");
  const [debouncedQuery, setDebouncedQuery] = useState("");
  const [page, setPage] = useState(1);
  const [total, setTotal] = useState(0);
  useEffect(() => {
    const timer = setTimeout(() => {
      setDebouncedQuery(query.trim());
      setPage(1);
    }, 300);
    return () => clearTimeout(timer);
  }, [query]);
  useEffect(() => {
    setLoading(true);
    const params = new URLSearchParams({
      limit: String(PAGE_SIZE),
      offset: String((page - 1) * PAGE_SIZE),
    });
    if (debouncedQuery) params.set("q", debouncedQuery);
    void authFetch(`${API}/operations/audit?${params}`, { headers: {} })
      .then((r) => r.json())
      .then((v) => {
        setItems(v.data?.items ?? []);
        setTotal(v.data?.total ?? 0);
      })
      .finally(() => setLoading(false));
  }, [page, debouncedQuery]);
  const visible = useMemo(() => items, [items]);
  const exportCsv = () => {
    downloadCsv(
      `audit-${new Date().toISOString().slice(0, 10)}.csv`,
      ["time", "module", "entity", "action", "actor", "previous", "new"],
      visible.map((item) => [
        new Date(item.createdAt).toISOString(),
        item.module,
        `${item.entity}${item.entityId ? `:${item.entityId}` : ""}`,
        item.action,
        item.performedByEmail ?? "system",
        detailOf(item.previousValue),
        detailOf(item.newValue),
      ]),
    );
  };

  return (
    <>
      <PageHeader
        title="Activity log"
        description="A record of what happened across the system, newest first. Kept for your records."
        actions={
          <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
            <SearchInput
              placeholder="Search action, module, actor…"
              value={query}
              onChange={setQuery}
              className="w-full sm:w-80"
            />
            <Button
              variant="outline"
              size="sm"
              disabled={visible.length === 0}
              onClick={exportCsv}
            >
              <Download className="size-3.5" />
              Export CSV
            </Button>
          </div>
        }
      />
      <Panel
        title="Activity records"
        description={`${total} records`}
        noPadding
      >
        {loading ? (
          <EmptyState loading>
            <span className="text-sm text-muted-foreground">
              Loading activity…
            </span>
          </EmptyState>
        ) : visible.length === 0 ? (
          <EmptyState
            title="No matching records"
            description="Try adjusting your search."
          />
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Time</TableHead>
                <TableHead>Module</TableHead>
                <TableHead>Entity</TableHead>
                <TableHead>Action</TableHead>
                <TableHead>Actor</TableHead>
                <TableHead>Change</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {visible.map((item) => (
                <TableRow key={item.id}>
                  <TableCell className="text-muted-foreground">
                    {new Date(item.createdAt).toLocaleString()}
                  </TableCell>
                  <TableCell>
                    <StatusBadge label={item.module} />
                  </TableCell>
                  <TableCell>
                    <span className="text-sm">
                      {item.entity.replaceAll("_", " ")}
                      {item.entityId && (
                        <span className="text-xs text-muted-foreground">
                          {" "}
                          · {item.entityId.slice(0, 8)}
                        </span>
                      )}
                    </span>
                  </TableCell>
                  <TableCell>
                    <span
                      className={cn(
                        "font-medium text-sm capitalize",
                        actionTone(item.action),
                      )}
                    >
                      {item.action.replaceAll("_", " ")}
                    </span>
                  </TableCell>
                  <TableCell className="text-xs text-muted-foreground">
                    {item.performedByEmail ?? "system"}
                  </TableCell>
                  <TableCell className="max-w-[240px]">
                    <code
                      className="block truncate rounded bg-muted px-1.5 py-0.5 text-xs text-muted-foreground"
                      title={detailOf(item.newValue)}
                    >
                      {detailOf(item.newValue)}
                    </code>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
        {!loading && total > 0 && (
          <PaginationBar
            page={page}
            pageSize={PAGE_SIZE}
            total={total}
            onPageChange={setPage}
          />
        )}
      </Panel>
    </>
  );
}
