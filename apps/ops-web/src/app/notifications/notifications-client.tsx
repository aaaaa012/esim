'use client';
import { useAuthenticatedFetch } from '../authenticated-api-provider';
import { useEffect, useState } from 'react';
import Link from 'next/link';
import { Bell, ExternalLink, RefreshCcw } from 'lucide-react';
import { Panel } from '@/components/panel';
import { StatusBadge, humane } from '@/components/status-badge';
import { Button } from '@/components/ui/button';
import { EmptyState } from '@/components/empty-state';
import { Spinner } from '@/components/spinner';
import ErrorDialog from '@/components/error-dialog';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';

const API = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:4000/api/v1';
const headers = {};
type Notification = {
  id: string;
  orderId?: string;
  channel: string;
  template: string;
  status: string;
  sentAt?: string;
  createdAt: string;
};
type Health = { queue: string; mode: string; channels: { email: string; whatsapp: string }; operational: boolean };

export default function NotificationsClient() {
  const authFetch = useAuthenticatedFetch();
  const [items, setItems] = useState<Notification[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const [health, setHealth] = useState<Health | null>(null);
  const load = () =>
    Promise.all([
      authFetch(`${API}/operations/notifications`, { headers }),
      authFetch(`${API}/operations/notifications/health`, { headers }),
    ]).then(async ([historyResponse, healthResponse]) => {
      const [historyValue, healthValue] = await Promise.all([historyResponse.json(), healthResponse.json()]);
      if (!historyResponse.ok) throw new Error(historyValue.error?.message);
      if (!healthResponse.ok) throw new Error(healthValue.error?.message);
      setItems(historyValue.data);
      setHealth(healthValue.data);
    });
  useEffect(() => {
    void load()
      .catch((cause) => setError(cause.message))
      .finally(() => setLoading(false));
  }, []);
  const retry = async (id: string) => {
    setBusy(id);
    setError('');
    try {
      const response = await authFetch(`${API}/operations/notifications/${id}/retry`, {
        method: 'POST',
        headers: { ...headers, 'x-idempotency-key': crypto.randomUUID() },
      });
      const value = await response.json();
      if (!response.ok) throw new Error(value.error?.message);
      await load();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Retry failed');
    } finally {
      setBusy('');
    }
  };

  return (
    <>
      {health && <div className={`mb-6 grid gap-3 rounded-xl border p-4 sm:grid-cols-4 ${health.operational ? 'bg-card' : 'border-destructive/30 bg-destructive/5'}`}><div><p className="text-xs text-muted-foreground">Delivery</p><StatusBadge label={health.operational ? 'OPERATIONAL' : 'ACTION REQUIRED'} /></div><div><p className="text-xs text-muted-foreground">Queue</p><p className="mt-1 text-sm font-medium">{health.queue}</p></div><div><p className="text-xs text-muted-foreground">Mode</p><p className="mt-1 text-sm font-medium">{health.mode}</p></div><div><p className="text-xs text-muted-foreground">Email sending</p><p className="mt-1 text-sm font-medium">{humane(health.channels.email)}</p></div>{!health.operational&&<p className="sm:col-span-4 text-sm text-destructive">Automatic sending needs to be configured before failed messages can be retried. Please ask a technical team member to set up email sending.</p>}</div>}
      {error && (
        <ErrorDialog error={error} onClose={() => setError('')} />
      )}
      <Panel
        title={
          <span className="flex items-center gap-2">
            <Bell className="size-4 text-primary" /> Delivery history
          </span>
        }
        description={`${items.length} messages`}
        noPadding
      >
        {loading ? (
          <EmptyState loading>
            <span className="text-sm text-muted-foreground">Loading messages…</span>
          </EmptyState>
        ) : items.length === 0 ? (
          <EmptyState title="No messages yet" description="Emails the system sends to customers will appear here." />
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Created</TableHead>
                <TableHead>Order</TableHead>
                <TableHead>Channel</TableHead>
                <TableHead>Template</TableHead>
                <TableHead>Status</TableHead>
                <TableHead className="text-right"></TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {items.map((item) => (
                <TableRow key={item.id}>
                  <TableCell className="text-muted-foreground">
                    {new Date(item.createdAt).toLocaleString()}
                  </TableCell>
                  <TableCell>
                    {item.orderId ? (
                      <Link
                        href={`/orders/${item.orderId}`}
                        className="inline-flex items-center gap-1 text-primary hover:underline"
                      >
                        View order <ExternalLink className="size-3" />
                      </Link>
                    ) : (
                      '—'
                    )}
                  </TableCell>
                  <TableCell className="font-medium">{humane(item.channel)}</TableCell>
                  <TableCell>{humane(item.template)}</TableCell>
                  <TableCell>
                    <StatusBadge label={item.status} />
                  </TableCell>
                  <TableCell className="text-right">
                    {item.status === 'FAILED' && (
                      <Button
                        variant="outline"
                        size="sm"
                        disabled={busy === item.id}
                        onClick={() => {
                          if (window.confirm("Send this message to the customer again?")) retry(item.id);
                        }}
                      >
                        {busy === item.id ? (
                          <Spinner />
                        ) : (
                          <RefreshCcw className="size-3.5" />
                        )}
                        Send again
                      </Button>
                    )}
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
