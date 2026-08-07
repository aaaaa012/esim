'use client';
import { useAuthenticatedFetch } from '../authenticated-api-provider';
import { useEffect, useState } from 'react';
import Link from 'next/link';
import { ArrowRight } from 'lucide-react';
import { PageHeader } from '@/components/page-header';
import { Panel } from '@/components/panel';
import { StatusBadge } from '@/components/status-badge';
import { SearchInput } from '@/components/search-input';
import { EmptyState } from '@/components/empty-state';
import { Spinner } from '@/components/spinner';
import { Button } from '@/components/ui/button';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';

const API = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:4000/api/v1';
type Audit = {
  id: string;
  orderId: string;
  orderNumber: string;
  module: string;
  action: string;
  previousStatus: string | null;
  reason?: string;
  createdAt: string;
};

export default function AuditClient() {
  const authFetch = useAuthenticatedFetch();
  const [items, setItems] = useState<Audit[]>([]);
  const [loading, setLoading] = useState(true);
  const [query, setQuery] = useState('');
  useEffect(() => {
    void authFetch(`${API}/operations/audit`, { headers: {} })
      .then((r) => r.json())
      .then((v) => setItems(v.data ?? []))
      .finally(() => setLoading(false));
  }, []);
  const visible = items.filter((item) =>
    `${item.orderNumber} ${item.action} ${item.reason ?? ''}`
      .toLowerCase()
      .includes(query.toLowerCase()),
  );

  return (
    <>
      <PageHeader
        title="Audit log"
        description="Immutable operational events ordered newest first."
        actions={
          <SearchInput
            placeholder="Search order, action, reason…"
            value={query}
            onChange={setQuery}
            className="w-full sm:w-80"
          />
        }
      />
      <Panel
        title="Audit events"
        description={`${visible.length} events`}
        noPadding
      >
        {loading ? (
          <EmptyState loading>
            <span className="text-sm text-muted-foreground">Loading audit events…</span>
          </EmptyState>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Time</TableHead>
                <TableHead>Module</TableHead>
                <TableHead>Order</TableHead>
                <TableHead>Transition</TableHead>
                <TableHead>Reason</TableHead>
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
                    <Button asChild variant="link" className="h-auto p-0 text-primary">
                      <Link href={`/orders/${item.orderId}`}>
                        {item.orderNumber}
                        <ArrowRight className="size-3" />
                      </Link>
                    </Button>
                  </TableCell>
                  <TableCell>
                    <span className="text-muted-foreground">
                      {item.previousStatus?.replaceAll('_', ' ') ?? 'CREATED'}
                    </span>
                    {" → "}
                    <span className="font-medium">{item.action.replaceAll('_', ' ')}</span>
                  </TableCell>
                  <TableCell className="text-muted-foreground">{item.reason ?? '—'}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </Panel>
    </>
  );
}