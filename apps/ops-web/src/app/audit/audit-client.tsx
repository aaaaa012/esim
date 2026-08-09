'use client';
import { useAuthenticatedFetch } from '../authenticated-api-provider';
import { useEffect, useMemo, useState } from 'react';
import { Download } from 'lucide-react';
import { PageHeader } from '@/components/page-header';
import { Panel } from '@/components/panel';
import { StatusBadge } from '@/components/status-badge';
import { SearchInput } from '@/components/search-input';
import { EmptyState } from '@/components/empty-state';
import { Button } from '@/components/ui/button';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { downloadCsv } from '@/lib/csv';

const API = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:4000/api/v1';
type Audit = {
  id: string;
  module: string;
  entity: string;
  entityId: string;
  action: string;
  performedByEmail: string | null;
  previousValue: unknown;
  newValue: unknown;
  createdAt: string;
};

const detailOf = (value: unknown) => {
  if (value === null || value === undefined) return '—';
  if (typeof value === 'string') return value;
  if (typeof value === 'object') return JSON.stringify(value);
  return String(value);
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
  const visible = useMemo(
    () =>
      items.filter((item) =>
        `${item.module} ${item.entity} ${item.action} ${item.performedByEmail ?? ''} ${detailOf(item.newValue)}`
          .toLowerCase()
          .includes(query.toLowerCase()),
      ),
    [items, query],
  );
  const exportCsv = () => {
    downloadCsv(
      `audit-${new Date().toISOString().slice(0, 10)}.csv`,
      ['time', 'module', 'entity', 'action', 'actor', 'previous', 'new'],
      visible.map((item) => [
        new Date(item.createdAt).toISOString(),
        item.module,
        `${item.entity}${item.entityId ? `:${item.entityId}` : ''}`,
        item.action,
        item.performedByEmail ?? 'system',
        detailOf(item.previousValue),
        detailOf(item.newValue),
      ]),
    );
  };

  return (
    <>
      <PageHeader
        title="Audit log"
        description="Immutable operational events ordered newest first."
        actions={
          <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
            <SearchInput
              placeholder="Search action, module, actor…"
              value={query}
              onChange={setQuery}
              className="w-full sm:w-80"
            />
            <Button
              variant="outline"
              size="sm"
              disabled={visible.length === 0}
              onClick={exportCsv}
            >
              <Download className="size-3.5" />
              Export CSV
            </Button>
          </div>
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
        ) : visible.length === 0 ? (
          <EmptyState title="No matching events" description="Try adjusting your search." />
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Time</TableHead>
                <TableHead>Module</TableHead>
                <TableHead>Entity</TableHead>
                <TableHead>Action</TableHead>
                <TableHead>Actor</TableHead>
                <TableHead>Change</TableHead>
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
                    <span className="text-sm">
                      {item.entity.replaceAll('_', ' ')}
                      {item.entityId && (
                        <span className="text-xs text-muted-foreground">
                          {" "}· {item.entityId.slice(0, 8)}
                        </span>
                      )}
                    </span>
                  </TableCell>
                  <TableCell>
                    <span className="font-medium text-sm">
                      {item.action.replaceAll('_', ' ')}
                    </span>
                  </TableCell>
                  <TableCell className="text-xs text-muted-foreground">
                    {item.performedByEmail ?? 'system'}
                  </TableCell>
                  <TableCell className="max-w-[240px] truncate text-xs text-muted-foreground">
                    {detailOf(item.newValue)}
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