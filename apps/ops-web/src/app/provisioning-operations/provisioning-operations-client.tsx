'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { RefreshCcw } from 'lucide-react';
import { useAuthenticatedFetch } from '../authenticated-api-provider';
import { PageHeader } from '@/components/page-header';
import { Panel } from '@/components/panel';
import { StatusBadge, humane } from '@/components/status-badge';
import { Button } from '@/components/ui/button';
import { EmptyState } from '@/components/empty-state';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';

const API = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:4000/api/v1';
type Operation = {
  id: string;
  orderId: string;
  state: string;
  iccid: string;
  providerSubscriptionId?: string | null;
  lastErrorCategory?: string | null;
  lastErrorMessage?: string | null;
  updatedAt: string;
  order: { orderNumber: string; status: string; orderType: string };
};
const recoverable = new Set(['ACCEPTED', 'WAITING_FOR_QR', 'RECONCILE_REQUIRED', 'MANUAL_REVIEW']);

export default function ProvisioningOperationsClient() {
  const authFetch = useAuthenticatedFetch();
  const [items, setItems] = useState<Operation[]>([]);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState('');
  const load = async () => {
    const response = await authFetch(`${API}/operations/provisioning-operations`, { headers: {} });
    const value = await response.json();
    if (!response.ok) throw new Error(value.error?.message ?? 'Could not load set-up recovery');
    setItems(value.data ?? []);
  };
  useEffect(() => {
    void load().catch((cause) => setError(cause instanceof Error ? cause.message : 'Load failed'));
  }, []);
  const reconcile = async (id: string) => {
    setBusy(id);
    setError('');
    try {
      const response = await authFetch(`${API}/operations/provisioning-operations/${id}/reconcile`, {
        method: 'POST',
        headers: { 'x-idempotency-key': crypto.randomUUID() },
      });
      const value = await response.json();
      if (!response.ok) throw new Error(value.error?.message ?? 'Check failed');
      await load();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Check failed');
    } finally {
      setBusy('');
    }
  };
  return (
    <>
      <PageHeader
        title="Set-up recovery"
        description="Orders where the network set-up is stuck or uncertain. Use Check again to safely continue without creating a duplicate."
        actions={<Button variant="outline" onClick={() => void load()}><RefreshCcw className="size-4" />Refresh</Button>}
      />
      {error ? <div className="mb-6 rounded-lg border border-destructive/30 bg-destructive/5 px-4 py-3 text-sm text-destructive">{error}</div> : null}
      <Panel title="Orders needing attention" description="Set-ups that are delayed, uncertain, or waiting for review" noPadding>
        {!items.length ? (
          <EmptyState title="Nothing is stuck" description="All network set-ups are moving normally. This screen is for rare recovery cases." />
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Order</TableHead>
                <TableHead>Status</TableHead>
                <TableHead>eSIM</TableHead>
                <TableHead>Last problem</TableHead>
                <TableHead>Updated</TableHead>
                <TableHead className="text-right">Action</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {items.map((item) => (
                <TableRow key={item.id}>
                  <TableCell>
                    <Link href={`/orders/${item.orderId}`} className="font-medium text-primary hover:underline">{item.order.orderNumber}</Link>
                    <div className="text-xs text-muted-foreground">{humane(item.order.orderType)} · {humane(item.order.status)}</div>
                  </TableCell>
                  <TableCell><StatusBadge label={item.state} /></TableCell>
                  <TableCell><code className="text-xs">{item.iccid}</code></TableCell>
                  <TableCell className="max-w-72 text-xs text-muted-foreground">{item.lastErrorMessage ?? item.lastErrorCategory ?? '—'}</TableCell>
                  <TableCell className="text-xs text-muted-foreground">{new Date(item.updatedAt).toLocaleString()}</TableCell>
                  <TableCell className="text-right">
                    <div className="flex justify-end gap-2">
                      <Button size="sm" variant="ghost" asChild><Link href={`/orders/${item.orderId}`}>Open order</Link></Button>
                      {recoverable.has(item.state) ? (
                        <Button
                          size="sm"
                          variant="outline"
                          disabled={busy === item.id}
                          onClick={() => {
                            if (window.confirm("Check this set-up with the network again? This will not create a duplicate order.")) void reconcile(item.id);
                          }}
                        >
                          <RefreshCcw className="size-3.5" />Check again
                        </Button>
                      ) : null}
                    </div>
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
