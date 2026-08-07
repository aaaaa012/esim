'use client';
import { useAuthenticatedFetch } from '../authenticated-api-provider';
import { useEffect, useState } from 'react';
import Link from 'next/link';
import { Bell, ExternalLink, RefreshCcw } from 'lucide-react';
import { PageHeader } from '@/components/page-header';
import { Panel } from '@/components/panel';
import { StatusBadge } from '@/components/status-badge';
import { Button } from '@/components/ui/button';
import { EmptyState } from '@/components/empty-state';
import { Spinner } from '@/components/spinner';
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

export default function NotificationsClient() {
  const authFetch = useAuthenticatedFetch();
  const [items, setItems] = useState<Notification[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const load = () =>
    authFetch(`${API}/operations/notifications`, { headers }).then(async (response) => {
      const value = await response.json();
      if (!response.ok) throw new Error(value.error?.message);
      setItems(value.data);
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
      <PageHeader
        title="Notifications"
        description="Delivery attempts, channel health, failures and controlled retries."
      />
      {error && (
        <div className="mb-6 rounded-lg border border-destructive/30 bg-destructive/5 px-4 py-3 text-sm text-destructive">
          {error}
        </div>
      )}
      <Panel
        title={
          <span className="flex items-center gap-2">
            <Bell className="size-4 text-primary" /> Delivery history
          </span>
        }
        description={`${items.length} attempts`}
        noPadding
      >
        {loading ? (
          <EmptyState loading>
            <span className="text-sm text-muted-foreground">Loading delivery attempts…</span>
          </EmptyState>
        ) : items.length === 0 ? (
          <EmptyState title="No notifications queued" description="Nothing to show yet." />
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
                  <TableCell className="font-medium">{item.channel}</TableCell>
                  <TableCell>{item.template.replaceAll('_', ' ')}</TableCell>
                  <TableCell>
                    <StatusBadge label={item.status} />
                  </TableCell>
                  <TableCell className="text-right">
                    {item.status === 'FAILED' && (
                      <Button
                        variant="outline"
                        size="sm"
                        disabled={busy === item.id}
                        onClick={() => retry(item.id)}
                      >
                        {busy === item.id ? (
                          <Spinner />
                        ) : (
                          <RefreshCcw className="size-3.5" />
                        )}
                        Retry
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