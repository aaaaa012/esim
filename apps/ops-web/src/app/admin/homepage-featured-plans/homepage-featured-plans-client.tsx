"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { useAuthenticatedFetch } from "../../authenticated-api-provider";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { PageHeader } from "@/components/page-header";
import { Panel } from "@/components/panel";
import { Spinner } from "@/components/spinner";
import { Trash2 } from "lucide-react";
import { toast } from "sonner";
import { useConfirmation } from "@/components/confirmation-provider";

const API = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:4000/api/v1";
type Plan = { id: string; name: string; countryCode: string; countryName: string; sellingPriceNpr: number; status: string };
type Feature = { id: string; planId: string; sortOrder: number; active: boolean; startsAt: string | null; endsAt: string | null; plan: Plan };

const toUtc = (value: string) => value ? new Date(`${value}:00+05:45`).toISOString() : null;
const toNepalInput = (value: string | null) => {
  if (!value) return "";
  const date = new Date(value);
  return new Date(date.getTime() + 5.75 * 60 * 60 * 1000).toISOString().slice(0, 16);
};

export default function HomepageFeaturedPlansClient() {
  const authFetch = useAuthenticatedFetch();
  const confirm = useConfirmation();
  const [plans, setPlans] = useState<Plan[]>([]);
  const [features, setFeatures] = useState<Feature[]>([]);
  const [planId, setPlanId] = useState("");
  const [sortOrder, setSortOrder] = useState("0");
  const [startsAt, setStartsAt] = useState("");
  const [endsAt, setEndsAt] = useState("");
  const [busy, setBusy] = useState(false);
  const request = useCallback(async <T,>(path: string, init?: RequestInit) => {
    const response = await authFetch(`${API}${path}`, { ...init, headers: { "content-type": "application/json", ...init?.headers } });
    const payload = await response.json();
    if (!response.ok) throw new Error(payload?.error?.message || "Request failed");
    return payload.data as T;
  }, [authFetch]);
  const load = useCallback(async () => {
    const [planItems, featureItems] = await Promise.all([
      request<Plan[]>("/admin/plans"),
      request<Feature[]>("/admin/homepage-featured-plans"),
    ]);
    setPlans(planItems.filter((plan) => plan.status === "ACTIVE"));
    setFeatures(featureItems);
  }, [request]);
  useEffect(() => { void load().catch((error) => toast.error(error.message)); }, [load]);
  const available = useMemo(() => plans.filter((plan) => !features.some((feature) => feature.planId === plan.id && feature.active)), [plans, features]);
  const add = async () => {
    if (!planId) return toast.error("Choose a plan");
    setBusy(true);
    try {
      await request("/admin/homepage-featured-plans", { method: "POST", body: JSON.stringify({ planId, sortOrder: Number(sortOrder) || 0, active: true, startsAt: toUtc(startsAt), endsAt: toUtc(endsAt) }) });
      setPlanId(""); setStartsAt(""); setEndsAt(""); await load(); toast.success("Recommendation added");
    } catch (error) { toast.error(error instanceof Error ? error.message : "Could not add recommendation"); }
    finally { setBusy(false); }
  };
  const update = async (feature: Feature, data: Partial<Feature>) => {
    await request(`/admin/homepage-featured-plans/${feature.id}`, { method: "PATCH", body: JSON.stringify(data) });
    await load();
  };
  const remove = async (feature: Feature) => {
    const confirmed = await confirm({
      title: "Remove recommendation?",
      description: `${feature.plan.countryName} will no longer appear in Traveller favourites.`,
      confirmLabel: "Remove",
      destructive: true,
    });
    if (!confirmed) return;
    await request(`/admin/homepage-featured-plans/${feature.id}`, { method: "DELETE" });
    await load();
  };
  return <>
    <PageHeader title="Traveller favourites" description="Curate and schedule the recommended plans shown directly below the customer homepage hero." />
    <div className="grid gap-6 xl:grid-cols-[minmax(320px,.75fr)_minmax(0,1.4fr)]">
      <Panel title="Add recommendation" description="Schedule inputs use Nepal time.">
        <div className="space-y-4">
          <select className="flex h-10 w-full rounded-md border bg-background px-3 text-sm" value={planId} onChange={(event) => setPlanId(event.target.value)}>
            <option value="">Choose an active plan</option>
            {available.map((plan) => <option key={plan.id} value={plan.id}>{plan.countryName} — {plan.name}</option>)}
          </select>
          <Input aria-label="Sort order" type="number" min="0" value={sortOrder} onChange={(event) => setSortOrder(event.target.value)} />
          <label className="grid gap-1 text-sm">Starts (optional)<Input type="datetime-local" value={startsAt} onChange={(event) => setStartsAt(event.target.value)} /></label>
          <label className="grid gap-1 text-sm">Ends (optional)<Input type="datetime-local" value={endsAt} onChange={(event) => setEndsAt(event.target.value)} /></label>
          <Button className="w-full" disabled={busy} onClick={() => void add()}>{busy ? <Spinner /> : "Add to homepage"}</Button>
        </div>
      </Panel>
      <Panel title="Configured recommendations" description={`${features.length} configured`}>
        <div className="space-y-3">
          {features.map((feature) => <article key={feature.id} className="grid gap-3 rounded-xl border p-4 lg:grid-cols-[minmax(180px,1fr)_90px_180px_180px_auto_auto] lg:items-end">
            <div><b>{feature.plan.countryName}</b><p className="text-sm text-muted-foreground">{feature.plan.name} · NPR {feature.plan.sellingPriceNpr.toLocaleString()}</p></div>
            <label className="grid gap-1 text-xs text-muted-foreground">Order<Input aria-label={`Sort order for ${feature.plan.countryName}`} type="number" min="0" defaultValue={feature.sortOrder} onBlur={(event) => void update(feature, { sortOrder: Number(event.target.value) || 0 })} /></label>
            <label className="grid gap-1 text-xs text-muted-foreground">Starts<Input type="datetime-local" defaultValue={toNepalInput(feature.startsAt)} onBlur={(event) => void update(feature, { startsAt: toUtc(event.target.value) })} /></label>
            <label className="grid gap-1 text-xs text-muted-foreground">Ends<Input type="datetime-local" defaultValue={toNepalInput(feature.endsAt)} onBlur={(event) => void update(feature, { endsAt: toUtc(event.target.value) })} /></label>
            <Button variant="outline" onClick={() => void update(feature, { active: !feature.active })}>{feature.active ? "Pause" : "Activate"}</Button>
            <Button variant="ghost" aria-label={`Remove ${feature.plan.countryName}`} onClick={() => void remove(feature)}><Trash2 className="size-4" /></Button>
          </article>)}
          {!features.length ? <p className="py-12 text-center text-sm text-muted-foreground">No recommendations configured.</p> : null}
        </div>
      </Panel>
    </div>
  </>;
}
