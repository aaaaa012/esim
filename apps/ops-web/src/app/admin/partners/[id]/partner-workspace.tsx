'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { ArrowLeft, Download } from 'lucide-react';
import { useAuthenticatedFetch } from '../../../authenticated-api-provider';
import { PageHeader } from '@/components/page-header';
import { Panel } from '@/components/panel';
import { StatCard } from '@/components/stat-card';
import { StatusBadge } from '@/components/status-badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { downloadCsv } from '@/lib/csv';

const API = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:4000/api/v1';
type Summary = { currentBalancePaisa: number; ordersCreated: number; fulfilledOrders: number; failedOrders: number; totalOrderValuePaisa: number; totalCreditedPaisa: number; totalDebitedPaisa: number; totalRefundedPaisa: number };
type Order = { id: string; orderNumber: string; externalOrderId: string | null; status: string; totalAmount: string | number; createdAt: string; plan: { name: string; country: { isoCode: string } }; traveler?: { firstName: string; surname: string; email: string } | null };
type Ledger = { id: string; type: string; amountPaisa: number; balanceAfterPaisa: number; reference: string; createdAt: string; order?: { id: string; orderNumber: string; externalOrderId: string | null } | null };

export default function PartnerWorkspace({ id }: { id: string }) {
  const authFetch = useAuthenticatedFetch();
  const [summary, setSummary] = useState<Summary | null>(null);
  const [orders, setOrders] = useState<Order[]>([]);
  const [ledger, setLedger] = useState<Ledger[]>([]);
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  useEffect(() => {
    const params = new URLSearchParams();
    if (from) params.set('from', new Date(`${from}T00:00:00.000Z`).toISOString());
    if (to) params.set('to', new Date(`${to}T23:59:59.999Z`).toISOString());
    const suffix = params.size ? `?${params}` : '';
    Promise.all([
      authFetch(`${API}/admin/partners/${id}/summary${suffix}`).then((response) => response.json()),
      authFetch(`${API}/admin/partners/${id}/orders${suffix}`).then((response) => response.json()),
      authFetch(`${API}/admin/partners/${id}/ledger${suffix}`).then((response) => response.json()),
    ]).then(([summaryValue, orderValue, ledgerValue]) => {
      setSummary(summaryValue.data ?? null);
      setOrders(orderValue.data ?? []);
      setLedger(ledgerValue.data ?? []);
    });
  }, [id, from, to]);
  const npr = (paisa: number) => `NPR ${(paisa / 100).toLocaleString()}`;
  return <div className="space-y-6">
    <Button asChild variant="ghost" size="sm"><Link href="/admin"><ArrowLeft className="size-4" />Administration</Link></Button>
    <PageHeader title="Partner workspace" description="Orders, prepaid balance and financial reconciliation." />
    <div className="flex flex-wrap gap-3"><Input type="date" aria-label="From date" value={from} onChange={(event) => setFrom(event.target.value)} className="w-44" /><Input type="date" aria-label="To date" value={to} onChange={(event) => setTo(event.target.value)} className="w-44" /></div>
    {summary && <div className="grid gap-4 md:grid-cols-4"><StatCard label="Available balance" value={npr(summary.currentBalancePaisa)} /><StatCard label="Orders" value={summary.ordersCreated} /><StatCard label="Fulfilled" value={summary.fulfilledOrders} /><StatCard label="Failed" value={summary.failedOrders} /></div>}
    <Tabs defaultValue="orders">
      <TabsList><TabsTrigger value="orders">Orders</TabsTrigger><TabsTrigger value="ledger">Ledger</TabsTrigger><TabsTrigger value="overview">Overview</TabsTrigger></TabsList>
      <TabsContent value="orders"><Panel title="Partner orders" action={<Button variant="outline" size="sm" onClick={() => downloadCsv('partner-orders.csv', ['orderNumber','externalOrderId','status','amountNpr','createdAt'], orders.map((order) => [order.orderNumber, order.externalOrderId ?? '', order.status, Number(order.totalAmount), order.createdAt]))}><Download className="size-4" />Export CSV</Button>} noPadding><Table><TableHeader><TableRow><TableHead>Order</TableHead><TableHead>Traveller</TableHead><TableHead>Plan</TableHead><TableHead>Amount</TableHead><TableHead>Status</TableHead></TableRow></TableHeader><TableBody>{orders.map((order) => <TableRow key={order.id}><TableCell><Link className="font-medium hover:underline" href={`/orders/${order.id}`}>{order.orderNumber}</Link><p className="text-xs text-muted-foreground">{order.externalOrderId ?? '—'}</p></TableCell><TableCell>{order.traveler ? `${order.traveler.firstName} ${order.traveler.surname}` : '—'}</TableCell><TableCell>{order.plan.country.isoCode} · {order.plan.name}</TableCell><TableCell>NPR {Number(order.totalAmount).toLocaleString()}</TableCell><TableCell><StatusBadge label={order.status} /></TableCell></TableRow>)}</TableBody></Table></Panel></TabsContent>
      <TabsContent value="ledger"><Panel title="Financial ledger" action={<Button variant="outline" size="sm" onClick={() => downloadCsv('partner-ledger.csv', ['type','amountNpr','balanceAfterNpr','reference','orderNumber','createdAt'], ledger.map((entry) => [entry.type, entry.amountPaisa / 100, entry.balanceAfterPaisa / 100, entry.reference, entry.order?.orderNumber ?? '', entry.createdAt]))}><Download className="size-4" />Export CSV</Button>} noPadding><Table><TableHeader><TableRow><TableHead>Date</TableHead><TableHead>Type</TableHead><TableHead>Order/reference</TableHead><TableHead>Amount</TableHead><TableHead>Balance after</TableHead></TableRow></TableHeader><TableBody>{ledger.map((entry) => <TableRow key={entry.id}><TableCell>{new Date(entry.createdAt).toLocaleString()}</TableCell><TableCell><StatusBadge label={entry.type} /></TableCell><TableCell>{entry.order?.orderNumber ?? entry.reference}<p className="text-xs text-muted-foreground">{entry.reference}</p></TableCell><TableCell>{npr(entry.amountPaisa)}</TableCell><TableCell>{npr(entry.balanceAfterPaisa)}</TableCell></TableRow>)}</TableBody></Table></Panel></TabsContent>
      <TabsContent value="overview">{summary && <Panel title="Reconciliation summary"><dl className="grid gap-4 sm:grid-cols-2"><div><dt className="text-sm text-muted-foreground">Order value</dt><dd className="font-medium">{npr(summary.totalOrderValuePaisa)}</dd></div><div><dt className="text-sm text-muted-foreground">Credits</dt><dd className="font-medium">{npr(summary.totalCreditedPaisa)}</dd></div><div><dt className="text-sm text-muted-foreground">Debits</dt><dd className="font-medium">{npr(summary.totalDebitedPaisa)}</dd></div><div><dt className="text-sm text-muted-foreground">Refunds</dt><dd className="font-medium">{npr(summary.totalRefundedPaisa)}</dd></div></dl></Panel>}</TabsContent>
    </Tabs>
  </div>;
}
