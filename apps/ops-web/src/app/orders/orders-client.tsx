'use client';
import { useAuthenticatedFetch } from '../authenticated-api-provider';
import { useEffect, useState } from 'react';
import Link from 'next/link';
import { ArrowRight, Download } from 'lucide-react';
import { Panel } from '@/components/panel';
import { StatusBadge } from '@/components/status-badge';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { EmptyState } from '@/components/empty-state';
import { SearchInput } from '@/components/search-input';
import { Spinner } from '@/components/spinner';
import { PaginationBar } from '@/components/pagination-bar';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Input } from '@/components/ui/input';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { downloadCsv } from '@/lib/csv';

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
  channel?: 'CUSTOMER_WEB' | 'PARTNER_API' | 'PARTNER_HOSTED';
  topUpMobile?: string;
  externalOrderId?: string | null;
  partner?: { id: string; code: string; name: string } | null;
};
export const opsHeaders = {};
const QUEUE_STATUSES = ['REVIEW_PENDING', 'AWAITING_CUSTOMER', 'PROVISIONING_FAILED'];
const PAGE_SIZE = 25;
const QUEUE_PAGE_SIZE = 200;

export default function OrdersClient({ queueOnly = false }: { queueOnly?: boolean }) {
  const authFetch = useAuthenticatedFetch();
  const [orders, setOrders] = useState<OpsOrder[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [loading, setLoading] = useState(true);
  const [query, setQuery] = useState('');
  const [debouncedQuery, setDebouncedQuery] = useState('');
  const [partners, setPartners] = useState<Array<{ id: string; code: string; name: string }>>([]);
  const [source, setSource] = useState('ALL');
  const [partnerId, setPartnerId] = useState('ALL');
  const [channel, setChannel] = useState('ALL');
  const [status, setStatus] = useState('ALL');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  useEffect(() => {
    if (queueOnly) return;
    const params = new URLSearchParams(window.location.search);
    const initialPartnerId = params.get('partnerId');
    if (initialPartnerId) { setPartnerId(initialPartnerId); setSource('PARTNER'); }
    const initialStatus = params.get('status');
    if (initialStatus) setStatus(initialStatus);
    authFetch(`${API}/operations/partners/options`, { headers: opsHeaders })
      .then((response) => response.json())
      .then((value) => setPartners(value.data ?? []));
  }, [queueOnly]);
  useEffect(() => {
    const timer = setTimeout(() => {
      setDebouncedQuery(query);
      setPage(1);
    }, 300);
    return () => clearTimeout(timer);
  }, [query]);
  useEffect(() => {
    if (queueOnly) {
      setLoading(true);
      authFetch(`${API}/operations/orders?limit=${QUEUE_PAGE_SIZE}`, { headers: opsHeaders })
        .then((r) => r.json())
        .then((v) => {
          setOrders(v.data?.items ?? []);
          setTotal(v.data?.total ?? 0);
        })
        .finally(() => setLoading(false));
      return;
    }
    setLoading(true);
    const params = new URLSearchParams({
      limit: String(PAGE_SIZE),
      offset: String((page - 1) * PAGE_SIZE),
    });
    if (debouncedQuery.trim()) params.set('q', debouncedQuery.trim());
    if (source !== 'ALL') params.set('source', source);
    if (partnerId !== 'ALL') params.set('partnerId', partnerId);
    if (channel !== 'ALL') params.set('channel', channel);
    if (status !== 'ALL') params.set('status', status);
    if (from) params.set('from', new Date(`${from}T00:00:00.000Z`).toISOString());
    if (to) params.set('to', new Date(`${to}T23:59:59.999Z`).toISOString());
    authFetch(`${API}/operations/orders?${params}`, { headers: opsHeaders })
      .then((r) => r.json())
      .then((v) => {
        setOrders(v.data?.items ?? []);
        setTotal(v.data?.total ?? 0);
      })
      .finally(() => setLoading(false));
  }, [queueOnly, page, debouncedQuery, source, partnerId, channel, status, from, to]);
  const visible = queueOnly
    ? orders.filter(
        (o) =>
          QUEUE_STATUSES.includes(o.status) &&
          `${o.orderNumber} ${o.traveler?.firstName ?? ''} ${o.traveler?.surname ?? ''}`
            .toLowerCase()
            .includes(query.toLowerCase()),
      )
    : orders;
  const exportCsv = () => {
    downloadCsv(
      `orders-${new Date().toISOString().slice(0, 10)}.csv`,
      ['orderNumber', 'externalOrderId', 'source', 'partner', 'status', 'customer', 'email', 'destination', 'amountNpr', 'createdAt'],
      visible.map((order) => [
        order.orderNumber,
        order.externalOrderId ?? '',
        order.partner ? 'PARTNER' : 'DIRECT',
        order.partner ? `${order.partner.name} (${order.partner.code})` : '',
        order.status,
        order.traveler ? `${order.traveler.firstName} ${order.traveler.surname}` : order.ownerId,
        order.traveler?.email ?? '',
        `${order.plan.countryCode} ${order.plan.name}`,
        order.totalAmountNpr,
        order.createdAt,
      ]),
    );
  };

  return (
    <div className="space-y-4">
      {!queueOnly && (
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <SearchInput
            placeholder="Order, external ID, traveller or partner…"
            value={query}
            onChange={setQuery}
            className="w-full sm:w-80"
          />
          <Select value={source} onValueChange={(value) => { setSource(value); setPartnerId('ALL'); setPage(1); }}>
            <SelectTrigger className="w-full sm:w-40"><SelectValue placeholder="Source" /></SelectTrigger>
            <SelectContent><SelectItem value="ALL">All sources</SelectItem><SelectItem value="DIRECT">Direct customer</SelectItem><SelectItem value="PARTNER">Partner</SelectItem></SelectContent>
          </Select>
          <Select value={partnerId} onValueChange={(value) => { setPartnerId(value); setSource(value === 'ALL' ? source : 'PARTNER'); setPage(1); }}>
            <SelectTrigger className="w-full sm:w-48"><SelectValue placeholder="Partner" /></SelectTrigger>
            <SelectContent><SelectItem value="ALL">All partners</SelectItem>{partners.map((partner) => <SelectItem key={partner.id} value={partner.id}>{partner.name}</SelectItem>)}</SelectContent>
          </Select>
          <Select value={channel} onValueChange={(value) => { setChannel(value); setPage(1); }}>
            <SelectTrigger className="w-full sm:w-44"><SelectValue placeholder="Channel" /></SelectTrigger>
            <SelectContent><SelectItem value="ALL">All channels</SelectItem><SelectItem value="CUSTOMER_WEB">Customer web</SelectItem><SelectItem value="PARTNER_API">Partner API</SelectItem><SelectItem value="PARTNER_HOSTED">Checkout link</SelectItem></SelectContent>
          </Select>
          <Select value={status} onValueChange={(value) => { setStatus(value); setPage(1); }}>
            <SelectTrigger className="w-full sm:w-44"><SelectValue placeholder="Status" /></SelectTrigger>
            <SelectContent><SelectItem value="ALL">All statuses</SelectItem>{['APPROVED','PROVISIONING','QR_READY','COMPLETED','PROVISIONING_FAILED','REFUND_PENDING','REFUNDED','CANCELLED'].map((value) => <SelectItem key={value} value={value}>{value.replaceAll('_', ' ')}</SelectItem>)}</SelectContent>
          </Select>
          <Input aria-label="From date" type="date" value={from} onChange={(event) => { setFrom(event.target.value); setPage(1); }} className="w-full sm:w-40" />
          <Input aria-label="To date" type="date" value={to} onChange={(event) => { setTo(event.target.value); setPage(1); }} className="w-full sm:w-40" />
          <div className="flex items-center gap-2">
            <span className="text-sm text-muted-foreground">{total} orders</span>
            <Button variant="outline" size="sm" disabled={visible.length === 0} onClick={exportCsv}>
              <Download className="size-3.5" />
              Export CSV
            </Button>
          </div>
        </div>
      )}
      <Panel
        title={queueOnly ? 'Orders needing attention' : 'Order list'}
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
                <TableHead>Channel</TableHead>
                <TableHead>Customer</TableHead>
                <TableHead>Destination</TableHead>
                <TableHead>Partner</TableHead>
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
                    <span className="inline-block rounded bg-muted px-1.5 py-0.5 text-[11px] uppercase tracking-wide">
                      {(order.channel ?? (order.partner ? (order.externalOrderId?.startsWith('vc-portal-') ? 'PARTNER_HOSTED' : 'PARTNER_API') : 'CUSTOMER_WEB')).replaceAll('_', ' ')}
                    </span>
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
                  <TableCell>
                    {order.partner ? <div><p className="font-medium">{order.partner.name}</p><p className="text-xs text-muted-foreground">{order.partner.code}</p></div> : <span className="text-muted-foreground">Direct</span>}
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
        {!queueOnly && !loading && (
          <PaginationBar
            page={page}
            pageSize={PAGE_SIZE}
            total={total}
            onPageChange={setPage}
          />
        )}
      </Panel>
    </div>
  );
}
