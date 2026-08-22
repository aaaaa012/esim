"use client";
import { useEffect, useState } from "react";
import Link from "next/link";
import { ArrowRight } from "lucide-react";
import { useAuthenticatedFetch } from "../authenticated-api-provider";
import { PageHeader } from "@/components/page-header";
import { Panel } from "@/components/panel";
import { humane } from "@/components/status-badge";
import { SearchInput } from "@/components/search-input";
import { PaginationBar } from "@/components/pagination-bar";
import { Spinner } from "@/components/spinner";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";

const API = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:4000/api/v1";
const PAGE_SIZE = 25;

type Customer = {
  ownerId: string;
  customerCode?: string | null;
  name: string;
  email: string;
  phone?: string | null;
  orders: number;
  completedEsims: number;
  activeEsims: number;
  spendNpr: number;
  remainingMb?: number | null;
  usageLastCheckedAt?: string | null;
  lastOrderAt?: string | null;
};

const ORDER_STATES = [
  "DRAFT",
  "PROVISIONING",
  "QR_READY",
  "COMPLETED",
  "PROVISIONING_FAILED",
  "REFUNDED",
];
const ESIM_STATES = [
  "PENDING",
  "ACTIVE",
  "SUSPENDED",
  "EXPIRED",
  "TERMINATED",
  "FAILED",
];

export default function CustomersClient() {
  const authFetch = useAuthenticatedFetch();
  const [items, setItems] = useState<Customer[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [loading, setLoading] = useState(true);
  const [query, setQuery] = useState("");
  const [debounced, setDebounced] = useState("");
  const [searchBy, setSearchBy] = useState("ALL");
  const [orderStatus, setOrderStatus] = useState("ALL");
  const [esimStatus, setEsimStatus] = useState("ALL");

  useEffect(() => {
    const timer = setTimeout(() => {
      setDebounced(query);
      setPage(1);
    }, 300);
    return () => clearTimeout(timer);
  }, [query]);

  useEffect(() => {
    setLoading(true);
    const params = new URLSearchParams({
      limit: String(PAGE_SIZE),
      offset: String((page - 1) * PAGE_SIZE),
      searchBy,
    });
    if (debounced.trim()) params.set("q", debounced.trim());
    if (orderStatus !== "ALL") params.set("orderStatus", orderStatus);
    if (esimStatus !== "ALL") params.set("esimStatus", esimStatus);
    void authFetch(`${API}/operations/customers?${params}`)
      .then((r) => r.json())
      .then((v) => {
        setItems(v.data?.items ?? []);
        setTotal(v.data?.total ?? 0);
      })
      .finally(() => setLoading(false));
  }, [authFetch, page, debounced, searchBy, orderStatus, esimStatus]);

  const searchFields = [
    { value: "ALL", label: "All fields" },
    { value: "NAME", label: "Name" },
    { value: "EMAIL", label: "Email" },
    { value: "PHONE", label: "Phone" },
    { value: "CUSTOMER_CODE", label: "Customer reference" },
    { value: "ORDER_NUMBER", label: "Order number" },
  ];

  return (
    <>
      <PageHeader
        title="Customers"
        description="Searchable customer, order, eSIM and usage overview."
      />
      <div className="mb-4 flex flex-wrap gap-2">
        <SearchInput
          value={query}
          onChange={setQuery}
          placeholder="Search customers…"
          className="w-full sm:w-72"
        />
        <Select value={searchBy} onValueChange={setSearchBy}>
          <SelectTrigger className="w-44">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {searchFields.map((item) => (
              <SelectItem key={item.value} value={item.value}>
                {item.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Select value={orderStatus} onValueChange={setOrderStatus}>
          <SelectTrigger className="w-44">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="ALL">All order states</SelectItem>
            {ORDER_STATES.map((v) => (
              <SelectItem key={v} value={v}>
                {humane(v)}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Select value={esimStatus} onValueChange={setEsimStatus}>
          <SelectTrigger className="w-44">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="ALL">All eSIM states</SelectItem>
            {ESIM_STATES.map((v) => (
              <SelectItem key={v} value={v}>
                {humane(v)}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
      <Panel
        title="Customer directory"
        description={`${total} customers`}
        noPadding
      >
        {loading ? (
          <div className="flex h-48 items-center justify-center">
            <Spinner />
          </div>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Customer</TableHead>
                <TableHead>Contact</TableHead>
                <TableHead>Orders</TableHead>
                <TableHead>Active eSIMs</TableHead>
                <TableHead>Remaining data</TableHead>
                <TableHead>Total spent</TableHead>
                <TableHead>Last order</TableHead>
                <TableHead className="sticky right-0 bg-card text-right">
                  Action
                </TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {items.map((c, index) => (
                <TableRow key={`${c.ownerId}-${c.customerCode ?? c.email}-${index}`}>
                  <TableCell>
                    <p className="font-medium">{c.name}</p>
                    <p className="text-xs text-muted-foreground">
                      {c.customerCode ?? "—"}
                    </p>
                  </TableCell>
                  <TableCell>
                    <p>{c.email}</p>
                    <p className="text-xs text-muted-foreground">
                      {c.phone ?? "—"}
                    </p>
                  </TableCell>
                  <TableCell>
                    {c.orders}
                    <p className="text-xs text-muted-foreground">
                      {c.completedEsims} completed
                    </p>
                  </TableCell>
                  <TableCell>{c.activeEsims}</TableCell>
                  <TableCell>
                    {c.remainingMb == null
                      ? "Not checked yet"
                      : `${c.remainingMb.toLocaleString()} MB`}
                    <p className="text-xs text-muted-foreground">
                      {c.usageLastCheckedAt
                        ? new Date(c.usageLastCheckedAt).toLocaleString()
                        : "—"}
                    </p>
                  </TableCell>
                  <TableCell>NPR {c.spendNpr.toLocaleString()}</TableCell>
                  <TableCell>
                    {c.lastOrderAt
                      ? new Date(c.lastOrderAt).toLocaleDateString()
                      : "—"}
                  </TableCell>
                  <TableCell className="sticky right-0 bg-card text-right">
                    <Button asChild size="sm" variant="outline">
                      <Link href={`/customers/${c.ownerId}`}>
                        Open <ArrowRight className="size-3.5" />
                      </Link>
                    </Button>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
        {!loading && total > 0 ? (
          <PaginationBar
            page={page}
            pageSize={PAGE_SIZE}
            total={total}
            onPageChange={setPage}
          />
        ) : null}
      </Panel>
    </>
  );
}
