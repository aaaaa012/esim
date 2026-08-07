'use client';
import { useAuthenticatedFetch } from '../authenticated-api-provider';
import { useEffect, useState } from 'react';
import Link from 'next/link';
import { ArrowRight } from 'lucide-react';
import { PageHeader } from '@/components/page-header';
import { Panel } from '@/components/panel';
import { EmptyState } from '@/components/empty-state';
import { SearchInput } from '@/components/search-input';
import { Spinner } from '@/components/spinner';
import { Button } from '@/components/ui/button';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';

const API = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:4000/api/v1';
type Customer = {
  ownerId: string;
  name: string;
  email: string;
  orders: number;
  completedEsims: number;
  lastOrderAt?: string;
};

export default function CustomersClient() {
  const authFetch = useAuthenticatedFetch();
  const [items, setItems] = useState<Customer[]>([]);
  const [loading, setLoading] = useState(true);
  const [query, setQuery] = useState('');
  useEffect(() => {
    void authFetch(`${API}/operations/customers`, { headers: {} })
      .then((r) => r.json())
      .then((v) => setItems(v.data ?? []))
      .finally(() => setLoading(false));
  }, []);

  const visible = items.filter((item) =>
    `${item.name} ${item.email} ${item.ownerId}`.toLowerCase().includes(query.toLowerCase()),
  );

  return (
    <>
      <PageHeader
        title="Customers"
        description="Customer profiles derived from synchronized identities and orders."
        actions={
          <SearchInput
            placeholder="Search name, email, identity…"
            value={query}
            onChange={setQuery}
            className="w-full sm:w-80"
          />
        }
      />
      <Panel
        title="Customer directory"
        description={`${visible.length} customers`}
        noPadding
      >
        {loading ? (
          <EmptyState loading>
            <span className="text-sm text-muted-foreground">Loading customers…</span>
          </EmptyState>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Customer</TableHead>
                <TableHead>Email</TableHead>
                <TableHead>Orders</TableHead>
                <TableHead>Completed eSIMs</TableHead>
                <TableHead>Last order</TableHead>
                <TableHead className="text-right"></TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {visible.map((item) => (
                <TableRow key={item.ownerId}>
                  <TableCell>
                    <Link
                      href={`/customers/${item.ownerId}`}
                      className="font-medium text-primary hover:underline"
                    >
                      {item.name}
                    </Link>
                    <p className="text-xs text-muted-foreground">{item.ownerId}</p>
                  </TableCell>
                  <TableCell className="text-muted-foreground">{item.email}</TableCell>
                  <TableCell className="tabular-nums">{item.orders}</TableCell>
                  <TableCell className="tabular-nums">{item.completedEsims}</TableCell>
                  <TableCell className="text-muted-foreground">
                    {item.lastOrderAt ? new Date(item.lastOrderAt).toLocaleDateString() : '—'}
                  </TableCell>
                  <TableCell className="text-right">
                    <Button asChild variant="ghost" size="sm">
                      <Link href={`/customers/${item.ownerId}`}>
                        View <ArrowRight className="size-3.5" />
                      </Link>
                    </Button>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </Panel>
    </>
  );
}