'use client';
import { useAuthenticatedFetch } from '../authenticated-api-provider';
import { useEffect, useState } from 'react';
import Link from 'next/link';
import { ArrowRight } from 'lucide-react';
import { Panel } from '@/components/panel';
import { StatusBadge } from '@/components/status-badge';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { EmptyState } from '@/components/empty-state';
import { SearchInput } from '@/components/search-input';
import { Spinner } from '@/components/spinner';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';

const API = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:4000/api/v1';
export type OpsOrder = {
  id: string;
  orderNumber: string;
  ownerId: string;
  status: string;
  createdAt: string;
  totalAmountNpr: number;
  plan: { name: string; countryCode: string };
  traveler?: { firstName: string; surname: string; email: string };
  purchaseType?: 'INITIAL_PURCHASE' | 'TOPUP';
  topUpMobile?: string;
};
export const opsHeaders = {};
const QUEUE_STATUSES = ['REVIEW_PENDING', 'AWAITING_CUSTOMER', 'PROVISIONING_FAILED'];

export default function OrdersClient({ queueOnly = false }: { queueOnly?: boolean }) {
  const authFetch = useAuthenticatedFetch();
  const [orders, setOrders] = useState<OpsOrder[]>([]);
  const [loading, setLoading] = useState(true);
  const [query, setQuery] = useState('');
  useEffect(() => {
    authFetch(`${API}/operations/orders`, { headers: opsHeaders })
      .then((r) => r.json())
      .then((v) => setOrders(v.data ?? []))
      .finally(() => setLoading(false));
  }, []);
  const visible = orders.filter(
    (o) =>
      (!queueOnly ||
        QUEUE_STATUSES.includes(o.status)) &&
      `${o.orderNumber} ${o.traveler?.firstName ?? ''} ${o.traveler?.surname ?? ''}`
        .toLowerCase()
        .includes(query.toLowerCase()),
  );

  return (
    <div className="space-y-4">
      {!queueOnly && (
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <SearchInput
            placeholder="Search orders…"
            value={query}
            onChange={setQuery}
            className="w-full sm:w-80"
          />
          <span className="text-sm text-muted-foreground">{visible.length} orders</span>
        </div>
      )}
      <Panel
        title="Orders"
        description={queueOnly ? 'Orders requiring attention' : undefined}
        noPadding
      >
        {loading ? (
          <EmptyState loading>
            <span className="text-sm text-muted-foreground">Loading orders…</span>
          </EmptyState>
        ) : visible.length === 0 ? (
          <EmptyState title="No matching orders" description="Try adjusting your search or filters." />
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Order</TableHead>
                <TableHead>Customer</TableHead>
                <TableHead>Destination</TableHead>
                <TableHead>Amount</TableHead>
                <TableHead>Status</TableHead>
                <TableHead className="text-right"></TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {visible.map((order) => (
                <TableRow key={order.id}>
                  <TableCell>
                    <p className="font-medium">{order.orderNumber}</p>
                    <p className="text-xs text-muted-foreground">
                      {new Date(order.createdAt).toLocaleDateString()}
                      {order.topUpMobile ? ` · ${order.topUpMobile}` : ''}
                    </p>
                  </TableCell>
                  <TableCell>
                    {order.traveler
                      ? `${order.traveler.firstName} ${order.traveler.surname}`
                      : order.ownerId}
                  </TableCell>
                  <TableCell>
                    {order.plan.countryCode} · {order.plan.name}
                    {order.purchaseType === 'TOPUP' && (
                      <Badge variant="info" className="ml-2">
                        TOP-UP
                      </Badge>
                    )}
                  </TableCell>
                  <TableCell className="tabular-nums">
                    NPR {order.totalAmountNpr.toLocaleString()}
                  </TableCell>
                  <TableCell>
                    <StatusBadge label={order.status} />
                  </TableCell>
                  <TableCell className="text-right">
                    <Button asChild variant="ghost" size="sm">
                      <Link href={`/orders/${order.id}`}>
                        Review <ArrowRight className="size-3.5" />
                      </Link>
                    </Button>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </Panel>
    </div>
  );
}