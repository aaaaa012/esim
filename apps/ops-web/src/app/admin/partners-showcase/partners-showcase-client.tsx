"use client";
import { useAuthenticatedFetch } from "../../authenticated-api-provider";
import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { ArrowLeft, Handshake, Plus, Save, Trash2 } from "lucide-react";
import { PageHeader } from "@/components/page-header";
import { Panel } from "@/components/panel";
import { StatusBadge } from "@/components/status-badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Spinner } from "@/components/spinner";
import { EmptyState } from "@/components/empty-state";
import { toast } from "sonner";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";

const API = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:4000/api/v1";
const headers = { "content-type": "application/json" };

type ShowcaseItem = {
  id: string;
  name: string;
  logoUrl: string | null;
  sortOrder: number;
  active: boolean;
  createdAt: string;
  updatedAt: string;
};

function Logo({ item, className }: { item: ShowcaseItem; className?: string }) {
  const [broken, setBroken] = useState(false);
  useEffect(() => setBroken(false), [item.logoUrl]);
  if (!item.logoUrl || broken) {
    return (
      <span className="flex size-full items-center justify-center bg-muted">
        <Handshake className="size-4 text-muted-foreground" />
      </span>
    );
  }
  return (
    // eslint-disable-next-line @next/next/no-img-element
    <img
      src={item.logoUrl}
      alt={`${item.name} logo`}
      referrerPolicy="no-referrer"
      loading="lazy"
      className={className}
      onError={() => setBroken(true)}
    />
  );
}

export default function PartnersShowcaseClient() {
  const authFetch = useAuthenticatedFetch();
  const request = useCallback(
    async <T,>(path: string, init?: RequestInit) => {
      const r = await authFetch(`${API}${path}`, {
        ...init,
        headers: { ...headers, ...init?.headers },
      });
      const v = await r.json();
      if (!r.ok) throw new Error(v.error?.message ?? "Request failed");
      return v.data as T;
    },
    [authFetch],
  );

  const [items, setItems] = useState<ShowcaseItem[]>([]);
  const [busy, setBusy] = useState(false);
  const [busyId, setBusyId] = useState("");
  const [name, setName] = useState("");
  const [logoUrl, setLogoUrl] = useState("");
  const [sortOrder, setSortOrder] = useState("0");
  const [editing, setEditing] = useState<ShowcaseItem | null>(null);

  const load = useCallback(async () => {
    try {
      setItems(await request<ShowcaseItem[]>("/admin/partner-showcase"));
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Could not load partners");
    }
  }, [request]);

  useEffect(() => {
    void load();
  }, [load]);

  const create = async () => {
    const trimmedName = name.trim();
    if (!trimmedName) {
      toast.error("Enter a partner name first");
      return;
    }
    setBusy(true);
    try {
      await request("/admin/partner-showcase", {
        method: "POST",
        body: JSON.stringify({
          name: trimmedName,
          ...(logoUrl.trim() ? { logoUrl: logoUrl.trim() } : {}),
          sortOrder: Number(sortOrder) || 0,
          active: true,
        }),
      });
      setName("");
      setLogoUrl("");
      setSortOrder("0");
      await load();
      toast.success(`${trimmedName} added to the homepage showcase`);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Create failed");
    } finally {
      setBusy(false);
    }
  };

  const save = async () => {
    if (!editing) return;
    if (!editing.name.trim()) {
      toast.error("Enter a partner name first");
      return;
    }
    setBusyId(editing.id);
    try {
      const updated = await request<ShowcaseItem>(
        `/admin/partner-showcase/${editing.id}`,
        {
          method: "PATCH",
          body: JSON.stringify({
            name: editing.name.trim(),
            logoUrl: editing.logoUrl?.trim() || null,
            sortOrder: Number(editing.sortOrder) || 0,
            active: editing.active,
          }),
        },
      );
      setItems((v) => v.map((item) => (item.id === updated.id ? updated : item)));
      setEditing(null);
      toast.success(`${updated.name} updated`);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Update failed");
    } finally {
      setBusyId("");
    }
  };

  const toggleActive = async (item: ShowcaseItem) => {
    setBusyId(item.id);
    try {
      const updated = await request<ShowcaseItem>(
        `/admin/partner-showcase/${item.id}`,
        {
          method: "PATCH",
          body: JSON.stringify({ active: !item.active }),
        },
      );
      setItems((v) => v.map((row) => (row.id === updated.id ? updated : row)));
      toast.success(`${updated.name} is now ${updated.active ? "visible" : "hidden"} on the homepage`);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Visibility update failed");
    } finally {
      setBusyId("");
    }
  };

  const remove = async (item: ShowcaseItem) => {
    if (!confirm(`Remove ${item.name} from the homepage showcase?`)) return;
    setBusyId(item.id);
    try {
      await request(`/admin/partner-showcase/${item.id}`, { method: "DELETE" });
      setItems((v) => v.filter((row) => row.id !== item.id));
      toast.success(`${item.name} removed`);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Delete failed");
    } finally {
      setBusyId("");
    }
  };

  return (
    <>
      <Button asChild variant="ghost" size="sm" className="mb-4">
        <Link href="/admin">
          <ArrowLeft className="size-4" />
          Administration
        </Link>
      </Button>

      <PageHeader
        title="Partner showcase"
        description="Partners displayed in the 'Trusted by leading travel providers' section on the customer homepage. Active entries appear on the public site."
        badge={
          <StatusBadge
            label={`${items.filter((item) => item.active).length} active`}
            tone="success"
          />
        }
      />

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-3">
        <Panel
          title="Add a partner"
          description="Name, optional logo URL, and ordering position."
        >
          <div className="space-y-4">
            <div className="space-y-1.5">
              <Label className="text-xs text-muted-foreground">Display name</Label>
              <Input
                placeholder="e.g. Himalayan Airways"
                value={name}
                onChange={(event) => setName(event.target.value)}
              />
            </div>
            <div className="space-y-1.5">
              <Label className="text-xs text-muted-foreground">Logo URL (optional)</Label>
              <Input
                placeholder="https://example.com/logo.png"
                value={logoUrl}
                onChange={(event) => setLogoUrl(event.target.value)}
              />
              <p className="text-xs text-muted-foreground">
                Use a direct link to an image file (.png, .jpg, .svg) so it renders correctly.
              </p>
            </div>
            <div className="space-y-1.5">
              <Label className="text-xs text-muted-foreground">Sort order (lower first)</Label>
              <Input
                type="number"
                min="0"
                max="9999"
                value={sortOrder}
                onChange={(event) => setSortOrder(event.target.value)}
              />
            </div>
            <Button className="w-full" disabled={busy} onClick={() => void create()}>
              {busy ? <Spinner className="text-primary-foreground" /> : <Plus className="size-4" />}
              Add partner
            </Button>
          </div>
        </Panel>

        <Panel
          title="Current showcase"
          description={`${items.length} partner(s) configured.`}
          className="lg:col-span-2"
          noPadding
        >
          {!items.length ? (
            <EmptyState
              title="No partners yet"
              description="Add your first partner on the left to publish the homepage section."
            />
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Partner</TableHead>
                  <TableHead>Sort order</TableHead>
                  <TableHead>Visible</TableHead>
                  <TableHead className="text-right"></TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {items.map((item) => (
                  <TableRow key={item.id}>
                    <TableCell>
                      <div className="flex items-center gap-3">
                        <span className="flex size-9 items-center justify-center overflow-hidden rounded-lg bg-muted">
                          <Logo item={item} className="size-full object-contain" />
                        </span>
                        <div>
                          <p className="font-medium">{item.name}</p>
                          <p className="max-w-56 truncate text-xs text-muted-foreground">
                            {item.logoUrl ?? "No logo"}
                          </p>
                        </div>
                      </div>
                    </TableCell>
                    <TableCell className="tabular-nums">{item.sortOrder}</TableCell>
                    <TableCell>
                      <Switch
                        checked={item.active}
                        disabled={busyId === item.id}
                        onCheckedChange={() => void toggleActive(item)}
                      />
                    </TableCell>
                    <TableCell className="text-right">
                      <div className="flex justify-end gap-2">
                        <Button
                          size="sm"
                          variant="outline"
                          disabled={busyId === item.id}
                          onClick={() => setEditing(item)}
                        >
                          <Save className="size-4" />
                          Edit
                        </Button>
                        <Button
                          size="sm"
                          variant="outline"
                          className="text-destructive hover:bg-destructive/10"
                          disabled={busyId === item.id}
                          onClick={() => void remove(item)}
                        >
                          {busyId === item.id ? <Spinner /> : <Trash2 className="size-4" />}
                          Remove
                        </Button>
                      </div>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </Panel>
      </div>

      <Dialog open={editing !== null} onOpenChange={(open) => !open && setEditing(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Edit partner</DialogTitle>
            <DialogDescription>
              Changes apply to the public homepage immediately.
            </DialogDescription>
          </DialogHeader>
          {editing && (
            <div className="space-y-4">
              <div className="space-y-1.5">
                <Label className="text-xs text-muted-foreground">Display name</Label>
                <Input
                  value={editing.name}
                  onChange={(event) =>
                    setEditing({ ...editing, name: event.target.value })
                  }
                />
              </div>
              <div className="space-y-1.5">
                <Label className="text-xs text-muted-foreground">Logo URL (optional)</Label>
                <Input
                  placeholder="https://example.com/logo.png"
                  value={editing.logoUrl ?? ""}
                  onChange={(event) =>
                    setEditing({ ...editing, logoUrl: event.target.value })
                  }
                />
                <p className="text-xs text-muted-foreground">
                  Use a direct link to an image file (.png, .jpg, .svg).
                </p>
              </div>
              <div className="space-y-1.5">
                <Label className="text-xs text-muted-foreground">Sort order (lower first)</Label>
                <Input
                  type="number"
                  min="0"
                  max="9999"
                  value={editing.sortOrder}
                  onChange={(event) =>
                    setEditing({ ...editing, sortOrder: Number(event.target.value) })
                  }
                />
              </div>
            </div>
          )}
          <DialogFooter>
            <Button variant="outline" onClick={() => setEditing(null)}>
              Cancel
            </Button>
            <Button disabled={busyId === editing?.id} onClick={() => void save()}>
              {busyId === editing?.id ? <Spinner className="text-primary-foreground" /> : <Save className="size-4" />}
              Save changes
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
