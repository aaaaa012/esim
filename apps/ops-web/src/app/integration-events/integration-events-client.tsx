'use client';
import { useAuthenticatedFetch } from '../authenticated-api-provider';
import { useEffect, useState } from 'react';
import { Panel } from '@/components/panel';
import { StatusBadge } from '@/components/status-badge';
import { EmptyState } from '@/components/empty-state';
import { Spinner } from '@/components/spinner';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';

const API = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:4000/api/v1';
const headers = {};
type Event = {
  id: string;
  source: string;
  eventId: string;
  signatureValid: boolean;
  processedAt?: string;
  errorMessage?: string;
  createdAt: string;
};

export default function IntegrationEventsClient() {
  const authFetch = useAuthenticatedFetch();
  const [items, setItems] = useState<Event[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  useEffect(() => {
    authFetch(`${API}/operations/integration-events`, { headers })
      .then(async (response) => {
        const value = await response.json();
        if (!response.ok) throw new Error(value.error?.message);
        setItems(value.data);
      })
      .catch((cause) => setError(cause.message))
      .finally(() => setLoading(false));
  }, []);

  return (
    <>
      {error && (
        <div className="mb-6 rounded-lg border border-destructive/30 bg-destructive/5 px-4 py-3 text-sm text-destructive">
          {error}
        </div>
      )}
      <Panel
        title="Provider callbacks"
        description={`${items.length} events`}
        noPadding
      >
        {loading ? (
          <EmptyState loading>
            <span className="text-sm text-muted-foreground">Loading callbacks…</span>
          </EmptyState>
        ) : !items.length ? (
          <EmptyState title="No provider callbacks" description="Nothing received yet." />
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Received</TableHead>
                <TableHead>Provider</TableHead>
                <TableHead>Event</TableHead>
                <TableHead>Signature</TableHead>
                <TableHead>Processing</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {items.map((item) => (
                <TableRow key={item.id}>
                  <TableCell className="text-muted-foreground">
                    {new Date(item.createdAt).toLocaleString()}
                  </TableCell>
                  <TableCell className="font-medium">{item.source.toUpperCase()}</TableCell>
                  <TableCell>
                    <code className="rounded bg-muted px-1.5 py-0.5 text-xs">
                      {item.eventId}
                    </code>
                  </TableCell>
                  <TableCell>
                    <StatusBadge label={item.signatureValid ? 'VERIFIED' : 'LOOKUP VERIFIED'} tone={item.signatureValid ? 'success' : 'warning'} />
                  </TableCell>
                  <TableCell>
                    <StatusBadge
                      label={item.errorMessage ? 'FAILED' : item.processedAt ? 'PROCESSED' : 'QUEUED'}
                    />
                    {item.errorMessage && (
                      <p className="mt-1 text-xs text-destructive">{item.errorMessage}</p>
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
