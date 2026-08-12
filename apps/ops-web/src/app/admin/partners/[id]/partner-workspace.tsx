'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { ArrowLeft, Download, Link2 } from 'lucide-react';
import { useAuthenticatedFetch } from '../../../authenticated-api-provider';
import { Spinner } from '@/components/spinner';
import { PageHeader } from '@/components/page-header';
import { Panel } from '@/components/panel';
import { StatCard } from '@/components/stat-card';
import { StatusBadge } from '@/components/status-badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { downloadCsv } from '@/lib/csv';
import { toast } from 'sonner';

const API = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:4000/api/v1';
type Summary = { currentBalancePaisa: number; ordersCreated: number; fulfilledOrders: number; failedOrders: number; totalOrderValuePaisa: number; totalCreditedPaisa: number; totalDebitedPaisa: number; totalRefundedPaisa: number; ordersByChannel?: Record<string, number> };
type Order = { id: string; orderNumber: string; externalOrderId: string | null; status: string; totalAmount: string | number; createdAt: string; plan: { name: string; country: { isoCode: string } }; traveler?: { firstName: string; surname: string; email: string } | null };
type Ledger = { id: string; type: string; amountPaisa: number; balanceAfterPaisa: number; reference: string; createdAt: string; order?: { id: string; orderNumber: string; externalOrderId: string | null } | null };
type Plan = { id: string; name: string; countryCode: string; countryName: string; sellingPriceNpr: number; status: string };
type PartnerInfo = { id: string; name: string; integrationType: 'API' | 'CHECKOUT_LINK' };

export default function PartnerWorkspace({ id }: { id: string }) {
  const authFetch = useAuthenticatedFetch();
  const [summary, setSummary] = useState<Summary | null>(null);
  const [orders, setOrders] = useState<Order[]>([]);
  const [ledger, setLedger] = useState<Ledger[]>([]);
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [plans, setPlans] = useState<Plan[]>([]);
  const [linkOpen, setLinkOpen] = useState(false);
  const [linkPlanId, setLinkPlanId] = useState('');
  const [linkMobile, setLinkMobile] = useState('');
  const [linkResult, setLinkResult] = useState<{ checkoutUrl: string; orderType?: string; topUpMobile?: string; topUpStatus?: "BOUND" | "UNAVAILABLE" } | null>(null);
  const [linkBusy, setLinkBusy] = useState(false);
  const [lookupState, setLookupState] = useState<{
    status: "idle" | "checking" | "ok" | "error";
    message?: string | undefined;
    subscriber?: { countryCode: string; countryName: string; currentPlan?: string | undefined; hasActiveEsim?: boolean };
    planCountryCode?: string | undefined;
  } | null>(null);
  const [partnerInfo, setPartnerInfo] = useState<PartnerInfo | null>(null);
  useEffect(() => {
    const params = new URLSearchParams();
    if (from) params.set('from', new Date(`${from}T00:00:00.000Z`).toISOString());
    if (to) params.set('to', new Date(`${to}T23:59:59.999Z`).toISOString());
    const suffix = params.size ? `?${params}` : '';
    Promise.all([
      authFetch(`${API}/admin/partners/${id}/summary${suffix}`).then((response) => response.json()),
      authFetch(`${API}/admin/partners/${id}/orders${suffix}`).then((response) => response.json()),
      authFetch(`${API}/admin/partners/${id}/ledger${suffix}`).then((response) => response.json()),
      authFetch(`${API}/admin/plans`).then((response) => response.json()),
      authFetch(`${API}/admin/partners`).then((response) => response.json()),
    ]).then(([summaryValue, orderValue, ledgerValue, plansValue, partnersValue]) => {
      setSummary(summaryValue.data ?? null);
      setOrders(orderValue.data ?? []);
      setLedger(ledgerValue.data ?? []);
      setPlans(plansValue.data ?? []);
      const row = (partnersValue.data ?? []).find((partner: PartnerInfo) => partner.id === id);
      setPartnerInfo(row ?? null);
    });
  }, [id, from, to]);
  const npr = (paisa: number) => `NPR ${(paisa / 100).toLocaleString()}`;
  const generateLink = async () => {
    if (!linkPlanId) {
      toast.error('Choose a plan first');
      return;
    }
    setLinkBusy(true);
    try {
      const body: Record<string, string> = { planId: linkPlanId, externalOrderId: `vc-portal-${Date.now()}`, externalCustomerId: `portal-customer-${Date.now()}` };
      if (linkMobile.trim()) body.topUpMobile = linkMobile.trim();
      const response = await authFetch(`${API}/admin/partners/${id}/hosted-checkout-sessions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      const v = await response.json();
      if (!response.ok) throw new Error(v.error?.message ?? 'Link generation failed');
      setLinkResult({
        checkoutUrl: v.data.checkoutUrl,
        ...(v.data.orderType ? { orderType: v.data.orderType } : {}),
        ...(v.data.topUp?.mobile ? { topUpMobile: v.data.topUp.mobile } : {}),
        ...(v.data.topUp?.status === "UNAVAILABLE" ? { topUpStatus: "UNAVAILABLE" } : v.data.topUp?.status === "BOUND" ? { topUpStatus: "BOUND" } : {}),
      });
      toast.success('Checkout link generated');
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Link generation failed');
    } finally {
      setLinkBusy(false);
    }
  };
  const validateMobile = async () => {
    const mobile = linkMobile.trim();
    const plan = plans.find((plan) => plan.id === linkPlanId);
    if (!mobile) { setLookupState(null); return; }
    setLookupState({ status: "checking" });
    try {
      const result = await authFetch(
        `${API}/operations/topup/lookup?mobile=${encodeURIComponent(mobile)}`,
      ).then((response) => response.json());
      if (!result?.data?.found || !result.data.subscriber) {
        setLookupState({ status: "error", message: "No completed order found for this number. This link will create a new purchase, not a top-up." });
        return;
      }
      const sub = result.data.subscriber;
      const sameCountry = plan !== undefined && sub.countryCode.toUpperCase() === plan.countryCode.toUpperCase();
      if (!sameCountry) {
        setLookupState({
          status: "error",
          subscriber: { countryCode: sub.countryCode, countryName: sub.countryName, currentPlan: sub.currentPlan?.name, hasActiveEsim: sub.hasActiveEsim },
          planCountryCode: plan?.countryCode,
          message: `Subscriber's existing plan is in ${sub.countryName} (${sub.countryCode}), which does not match the selected plan (${plan?.countryCode ?? "?"}). This will be a new purchase.`,
        });
        return;
      }
      setLookupState({
        status: "ok",
        subscriber: { countryCode: sub.countryCode, countryName: sub.countryName, currentPlan: sub.currentPlan?.name, hasActiveEsim: sub.hasActiveEsim },
        planCountryCode: plan?.countryCode,
        message: sub.hasActiveEsim === false ? "Subscriber found, but no active eSIM was detected. Confirm this is the correct number." : undefined,
      });
    } catch (error) {
      setLookupState({ status: "error", message: error instanceof Error ? error.message : "Lookup failed" });
    }
  };
  return <div className="space-y-6">
    <Button asChild variant="ghost" size="sm"><Link href="/admin"><ArrowLeft className="size-4" />Administration</Link></Button>
    <div className="flex items-center justify-between">
      <PageHeader
        title={`Partner workspace${partnerInfo ? ` — ${partnerInfo.name}` : ''}`}
        description={`Orders, prepaid balance and financial reconciliation. ${partnerInfo ? `${partnerInfo.integrationType === 'CHECKOUT_LINK' ? 'Checkout link (hosted) integration.' : 'REST API integration.'}` : ''}`}
      />
      {partnerInfo?.integrationType === 'CHECKOUT_LINK' && (
        <Button size="sm" onClick={() => { setLinkPlanId(''); setLinkMobile(''); setLinkResult(null); setLookupState(null); setLinkOpen(true); }}>
          <Link2 className="size-4" />Generate checkout link
        </Button>
      )}
    </div>
    <div className="flex flex-wrap gap-3"><Input type="date" aria-label="From date" value={from} onChange={(event) => setFrom(event.target.value)} className="w-44" /><Input type="date" aria-label="To date" value={to} onChange={(event) => setTo(event.target.value)} className="w-44" /></div>
    {summary && <div className="grid gap-4 md:grid-cols-4"><StatCard label="Available balance" value={npr(summary.currentBalancePaisa)} /><StatCard label="Orders" value={summary.ordersCreated} /><StatCard label="Fulfilled" value={summary.fulfilledOrders} /><StatCard label="Failed" value={summary.failedOrders} /></div>}
    <Tabs defaultValue="orders">
      <TabsList><TabsTrigger value="orders">Orders</TabsTrigger><TabsTrigger value="ledger">Ledger</TabsTrigger><TabsTrigger value="overview">Overview</TabsTrigger></TabsList>
      <TabsContent value="orders"><Panel title="Partner orders" action={<Button variant="outline" size="sm" onClick={() => downloadCsv('partner-orders.csv', ['orderNumber','externalOrderId','status','amountNpr','createdAt'], orders.map((order) => [order.orderNumber, order.externalOrderId ?? '', order.status, Number(order.totalAmount), order.createdAt]))}><Download className="size-4" />Export CSV</Button>} noPadding><Table><TableHeader><TableRow><TableHead>Order</TableHead><TableHead>Traveller</TableHead><TableHead>Plan</TableHead><TableHead>Amount</TableHead><TableHead>Status</TableHead></TableRow></TableHeader><TableBody>{orders.map((order) => <TableRow key={order.id}><TableCell><Link className="font-medium hover:underline" href={`/orders/${order.id}`}>{order.orderNumber}</Link><p className="text-xs text-muted-foreground">{order.externalOrderId ?? '—'}</p></TableCell><TableCell>{order.traveler ? `${order.traveler.firstName} ${order.traveler.surname}` : '—'}</TableCell><TableCell>{order.plan.country.isoCode} · {order.plan.name}</TableCell><TableCell>NPR {Number(order.totalAmount).toLocaleString()}</TableCell><TableCell><StatusBadge label={order.status} /></TableCell></TableRow>)}</TableBody></Table></Panel></TabsContent>
      <TabsContent value="ledger"><Panel title="Financial ledger" action={<Button variant="outline" size="sm" onClick={() => downloadCsv('partner-ledger.csv', ['type','amountNpr','balanceAfterNpr','reference','orderNumber','createdAt'], ledger.map((entry) => [entry.type, entry.amountPaisa / 100, entry.balanceAfterPaisa / 100, entry.reference, entry.order?.orderNumber ?? '', entry.createdAt]))}><Download className="size-4" />Export CSV</Button>} noPadding><Table><TableHeader><TableRow><TableHead>Date</TableHead><TableHead>Type</TableHead><TableHead>Order/reference</TableHead><TableHead>Amount</TableHead><TableHead>Balance after</TableHead></TableRow></TableHeader><TableBody>{ledger.map((entry) => <TableRow key={entry.id}><TableCell>{new Date(entry.createdAt).toLocaleString()}</TableCell><TableCell><StatusBadge label={entry.type} /></TableCell><TableCell>{entry.order?.orderNumber ?? entry.reference}<p className="text-xs text-muted-foreground">{entry.reference}</p></TableCell><TableCell>{npr(entry.amountPaisa)}</TableCell><TableCell>{npr(entry.balanceAfterPaisa)}</TableCell></TableRow>)}</TableBody></Table></Panel></TabsContent>
      <TabsContent value="overview">{summary && <Panel title="Reconciliation summary"><dl className="grid gap-4 sm:grid-cols-2"><div><dt className="text-sm text-muted-foreground">Order value</dt><dd className="font-medium">{npr(summary.totalOrderValuePaisa)}</dd></div><div><dt className="text-sm text-muted-foreground">Credits</dt><dd className="font-medium">{npr(summary.totalCreditedPaisa)}</dd></div><div><dt className="text-sm text-muted-foreground">Debits</dt><dd className="font-medium">{npr(summary.totalDebitedPaisa)}</dd></div><div><dt className="text-sm text-muted-foreground">Refunds</dt><dd className="font-medium">{npr(summary.totalRefundedPaisa)}</dd></div><div className="sm:col-span-2"><dt className="text-sm text-muted-foreground">Orders by channel</dt><dd className="flex flex-wrap gap-2 pt-1">{Object.entries(summary.ordersByChannel ?? {}).map(([channel, count]) => <span key={channel} className="inline-block rounded bg-muted px-2 py-1 text-xs">{channel.replaceAll('_', ' ')}: {count}</span>)}</dd></div></dl></Panel>}</TabsContent>
    </Tabs>
    <Dialog open={linkOpen} onOpenChange={(open) => { if (!open) setLinkOpen(false); }}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Generate checkout link</DialogTitle>
          <DialogDescription>
            Create a hosted no-code checkout link for this partner. Share it with the traveler; no API required.
          </DialogDescription>
        </DialogHeader>
        {!linkResult ? (
          <div className="space-y-4 pt-1">
            <div className="space-y-1.5">
              <Label className="text-xs text-muted-foreground">Plan</Label>
              <Select value={linkPlanId} onValueChange={setLinkPlanId}>
                <SelectTrigger>
                  <SelectValue placeholder="Choose a plan" />
                </SelectTrigger>
                <SelectContent>
                  {plans
                    .filter((plan) => plan.status === "ACTIVE")
                    .map((plan) => (
                      <SelectItem key={plan.id} value={plan.id}>
                        {plan.countryName} · {plan.name} · NPR {plan.sellingPriceNpr.toLocaleString()}
                      </SelectItem>
                    ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1.5">
              <Label className="text-xs text-muted-foreground">Earlier subscriber MSISDN (optional)</Label>
              <Input
                value={linkMobile}
                onChange={(event) => { setLinkMobile(event.target.value); setLookupState(null); }}
                onBlur={() => void validateMobile()}
                placeholder="e.g. 9779800000000 — the number used on the subscriber's earlier order, to top-up that same eSIM"
              />
              {lookupState && lookupState.status === "checking" && (
                <p className="flex items-center gap-2 text-xs text-muted-foreground">
                  <Spinner className="size-3" /> Checking for an existing eSIM…
                </p>
              )}
              {lookupState && lookupState.status === "ok" && (
                <div className="space-y-1 rounded-md bg-emerald-500/10 px-3 py-2 text-xs">
                  <p className="font-medium text-emerald-600">✓ Top-up available — subscriber found</p>
                  {lookupState.subscriber?.countryName && (
                    <p className="text-muted-foreground">
                      Existing eSIM: {lookupState.subscriber.countryName} ({lookupState.subscriber.countryCode})
                      {lookupState.subscriber.currentPlan ? ` · ${lookupState.subscriber.currentPlan}` : ""}
                    </p>
                  )}
                  {lookupState.message && <p className="text-amber-600">{lookupState.message}</p>}
                </div>
              )}
              {lookupState && lookupState.status === "error" && (
                <div className="space-y-1 rounded-md bg-destructive/10 px-3 py-2 text-xs">
                  <p className="font-medium text-destructive">{lookupState.message}</p>
                  {lookupState.subscriber?.countryName && (
                    <p className="text-muted-foreground">
                      Existing plan: {lookupState.subscriber.countryName} ({lookupState.subscriber.countryCode})
                      {lookupState.subscriber.currentPlan ? ` · ${lookupState.subscriber.currentPlan}` : ""} — selected plan is ({lookupState.planCountryCode ?? "?"})
                    </p>
                  )}
                </div>
              )}
            </div>
            <div className="flex justify-end gap-2">
              <Button variant="outline" onClick={() => setLinkOpen(false)}>Cancel</Button>
              <Button disabled={!linkPlanId || linkBusy} onClick={() => void generateLink()}>
                {linkBusy ? <Spinner className="size-4" /> : <Link2 className="size-4" />}
                Generate
              </Button>
            </div>
          </div>
) : (
          <div className="space-y-3 pt-1">
            {linkResult.orderType === 'TOPUP' ? (
              <p className="rounded-md bg-primary/10 px-3 py-2 text-xs font-medium text-primary">
                Top-up link — will attach to the eSIM for {linkResult.topUpMobile}. The traveler only sees 2 steps.
              </p>
            ) : (
              <p className="rounded-md bg-muted px-3 py-2 text-xs text-muted-foreground">
                New-purchase link — the traveler will complete all checkout steps.
                {linkResult.topUpMobile ? ' Note: mobile did not match an existing eSIM, so this is a new purchase.' : ''}
              </p>
            )}
            {linkResult.topUpStatus === 'UNAVAILABLE' && (
              <p className="rounded-md bg-amber-500/10 px-3 py-2 text-xs font-medium text-amber-700">
                {linkResult.topUpMobile} matched a subscriber but no active eSIM could be bound — this link will be
                processed as a new purchase, not a top-up. Proceed only if that is intended.
              </p>
            )}
            <code className="block break-all rounded-lg bg-muted px-3 py-2 text-xs">
              {linkResult.checkoutUrl}
            </code>
            <div className="flex gap-2">
              <Button
                size="sm"
                variant="outline"
                onClick={async () => {
                  try {
                    await navigator.clipboard.writeText(linkResult.checkoutUrl);
                    toast.success('Checkout link copied.');
                  } catch {
                    toast.error('Clipboard permission denied. Copy it manually.');
                  }
                }}
              >
                Copy link
              </Button>
              <Button size="sm" variant="outline" onClick={() => setLinkOpen(false)}>Done</Button>
            </div>
          </div>
        )}
      </DialogContent>
    </Dialog>
  </div>;
}
