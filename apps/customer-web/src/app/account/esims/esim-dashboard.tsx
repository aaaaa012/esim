'use client';

import Link from 'next/link';
import { useCallback, useEffect, useRef, useState } from 'react';
import {
  Activity,
  AlertCircle,
  CheckCircle2,
  Clock3,
  Download,
  HelpCircle,
  LoaderCircle,
  Mail,
  Plus,
  QrCode,
  RefreshCcw,
  Smartphone,
  Wifi,
  X,
} from 'lucide-react';
import { useAuthenticatedFetch } from '../../authenticated-api-provider';

const API = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:4000/api/v1';
const REFRESH_COOLDOWN_MS = 30_000;

type Usage = { usedMb: number; totalMb: number; remainingMb: number; lastCheckedAt?: string };
type Subscription = Usage & {
  id: string;
  orderId: string;
  orderNumber: string;
  status: string;
  assignmentVerificationStatus?: string;
  expiresAt?: string;
  lastCheckedAt?: string;
  plan: { name: string; countryCode: string; countryName: string; dataAllowance: string; validityDays: number };
};
type ActivityItem = { orderId: string; orderNumber: string; orderStatus: string; purchaseType: string; planName: string; countryCode: string; createdAt: string };
type Esim = { id: string; status: string; iccidMasked?: string; msisdnMasked?: string; usage: (Usage & { lastCheckedAt: string }) | null; subscriptions: Subscription[]; activity?: ActivityItem[]; qrOrderId?: string };

const formatData = (mb: number) => mb >= 1024 ? `${Number((mb / 1024).toFixed(2))} GB` : `${Math.round(mb).toLocaleString()} MB`;
const formatStatus = (esim: Esim) => {
  const active = esim.subscriptions.some((item) => item.status === 'ACTIVE');
  const pending = esim.subscriptions.some((item) => item.status === 'PENDING');
  const problem = esim.subscriptions.some((item) => item.assignmentVerificationStatus === 'MISMATCH');
  if (problem) return { label: 'Needs attention', tone: 'needs-attention', detail: 'We are checking this eSIM assignment.' };
  if (active) return { label: 'Active', tone: 'active', detail: 'Connected and ready to use.' };
  if (pending) return { label: 'Activating', tone: 'activating', detail: 'Your plan is being added.' };
  if (esim.qrOrderId) return { label: 'Ready', tone: 'ready', detail: 'Your eSIM is ready to install or reuse.' };
  return { label: 'No active plan', tone: 'no-plan', detail: 'Add a destination plan when you are ready.' };
};

function Battery({ usage, small = false }: { usage: Usage | null; small?: boolean }) {
  const pct = usage?.totalMb ? Math.max(0, Math.min(100, usage.remainingMb / usage.totalMb * 100)) : 0;
  const tone = !usage ? 'unknown' : pct < 20 ? 'low' : pct <= 50 ? 'medium' : 'good';
  return <div className={`battery-wrap ${small ? 'small' : ''}`}><div className={`battery ${tone}`} role="img" aria-label={usage ? `${Math.round(pct)} percent data remaining` : 'Usage unavailable'}><i style={{ height: `${pct}%` }} /></div><span><b>{usage ? formatData(usage.remainingMb) : '—'}</b><small>{usage ? `${Math.round(pct)}% remaining` : 'Usage unavailable'}</small></span></div>;
}

function DashboardSkeleton() {
  return <main className="account-page" aria-busy="true" aria-label="Loading your eSIM"><div className="shell"><div className="esim-skeleton heading" /><div className="esim-skeleton hero" /><div className="esim-skeleton usage" /><div className="esim-skeleton plans" /></div></main>;
}

function QrModal({ esim, authFetch, onClose }: { esim: Esim; authFetch: ReturnType<typeof useAuthenticatedFetch>; onClose: () => void }) {
  const [imageUrl, setImageUrl] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState<'qr' | 'pdf' | 'email' | ''>('qr');
  const [notice, setNotice] = useState('');
  const closeRef = useRef<HTMLButtonElement>(null);
  const dialogRef = useRef<HTMLDivElement>(null);

  const loadQr = useCallback(async () => {
    setBusy('qr'); setError(''); setNotice('');
    try {
      const response = await authFetch(`${API}/customer/esims/${esim.id}/activation-qr`, { headers: {} });
      if (!response.ok) {
        const value = await response.json().catch(() => null);
        throw new Error(value?.error?.message ?? 'Your activation QR could not be loaded.');
      }
      const url = URL.createObjectURL(await response.blob());
      setImageUrl((current) => { if (current) URL.revokeObjectURL(current); return url; });
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Your activation QR could not be loaded.');
    } finally { setBusy(''); }
  }, [authFetch, esim.id]);

  useEffect(() => { void loadQr(); return () => { setImageUrl((current) => { if (current) URL.revokeObjectURL(current); return ''; }); }; }, [loadQr]);
  useEffect(() => {
    closeRef.current?.focus();
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') return onClose();
      if (event.key !== 'Tab' || !dialogRef.current) return;
      const focusable = [...dialogRef.current.querySelectorAll<HTMLElement>('button:not(:disabled), a[href]')];
      if (!focusable.length) return;
      const first = focusable[0]!, last = focusable[focusable.length - 1]!;
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [onClose]);

  const downloadPdf = async () => {
    if (!esim.qrOrderId) return;
    setBusy('pdf'); setError(''); setNotice('');
    try {
      const response = await authFetch(`${API}/customer/orders/${esim.qrOrderId}/activation-qr`, { headers: {} });
      if (!response.ok) throw new Error('The protected QR PDF could not be downloaded.');
      const url = URL.createObjectURL(await response.blob());
      const link = document.createElement('a'); link.href = url; link.download = 'visa-compass-esim.pdf'; link.click(); URL.revokeObjectURL(url);
      setNotice('Protected QR PDF downloaded. Use the eSIM number from your email as its password.');
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'The protected QR PDF could not be downloaded.'); }
    finally { setBusy(''); }
  };
  const resendEmail = async () => {
    if (!esim.qrOrderId) return;
    setBusy('email'); setError(''); setNotice('');
    try {
      const response = await authFetch(`${API}/customer/orders/${esim.qrOrderId}/resend-qr`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-idempotency-key': crypto.randomUUID() }, body: '{}' });
      const value = await response.json();
      if (!response.ok) throw new Error(value?.error?.message ?? 'The QR email could not be sent.');
      setNotice('QR email sent. Check your inbox and spam folder.');
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'The QR email could not be sent.'); }
    finally { setBusy(''); }
  };

  return <div className="qr-modal-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}><div ref={dialogRef} className="qr-modal" role="dialog" aria-modal="true" aria-labelledby="qr-modal-title" aria-describedby="qr-modal-description"><button ref={closeRef} className="qr-modal-close" onClick={onClose} aria-label="Close activation QR"><X /></button><div className="qr-modal-heading"><span><QrCode /></span><div><small>Secure activation</small><h2 id="qr-modal-title">Install your eSIM</h2><p id="qr-modal-description">Scan this code from your phone’s mobile or cellular settings.</p></div></div><div className="qr-stage">{busy === 'qr' ? <div className="qr-loading"><LoaderCircle className="spin" /><span>Loading secure QR…</span></div> : error && !imageUrl ? <div className="qr-load-error"><AlertCircle /><b>QR unavailable</b><p>{error}</p><button className="button" onClick={() => void loadQr()}>Try again</button></div> : imageUrl ? <img src={imageUrl} alt="Visa Compass eSIM activation QR code" /> : null}</div><div className="qr-warning"><Smartphone /><p><b>Installing on this phone?</b><br />Open this dashboard on another screen to scan the QR, or download the protected PDF for later. Never share your QR.</p></div>{error && imageUrl && <div className="form-error" role="alert">{error}</div>}{notice && <div className="qr-notice ok" role="status">{notice}</div>}<ol className="install-steps"><li>Open Settings and choose Mobile/Cellular Data.</li><li>Choose Add eSIM or Add Cellular Plan.</li><li>Scan the code and follow the phone’s prompts.</li></ol><div className="qr-modal-actions"><button className="button secondary" disabled={Boolean(busy)} onClick={() => void resendEmail()}>{busy === 'email' ? <LoaderCircle className="spin" /> : <Mail />}Resend email</button><button className="button" disabled={Boolean(busy)} onClick={() => void downloadPdf()}>{busy === 'pdf' ? <LoaderCircle className="spin" /> : <Download />}Download protected PDF</button></div></div></div>;
}

function CurrentPlans({ plans }: { plans: Subscription[] }) {
  return <section className="plan-section"><div className="section-heading"><span><Activity /></span><div><h2>Current plans</h2><p>Your active and upcoming data packages.</p></div></div>{plans.length ? plans.map((plan) => <article className="plan-service-row" key={plan.id}><Battery small usage={plan.lastCheckedAt ? plan : null} /><div className="plan-copy"><b>{plan.plan.name}</b><span>{plan.plan.countryName} · {plan.plan.dataAllowance} · {plan.plan.validityDays} days</span><small>{plan.assignmentVerificationStatus === 'MISMATCH' ? 'We are checking this plan assignment' : plan.status === 'ACTIVE' ? 'Ready to use on this eSIM' : 'Adding this plan to your eSIM'}</small></div><div className="plan-state"><b>{plan.status === 'ACTIVE' ? 'Active' : 'Activating'}</b><small>{plan.expiresAt ? `Expires ${new Date(plan.expiresAt).toLocaleDateString()}` : 'Activation pending'}</small></div></article>) : <div className="inline-empty"><Wifi /><div><b>No active data plan</b><p>Your eSIM remains safely in your account and can be reused.</p></div></div>}</section>;
}

export default function EsimDashboard({ selectedId }: { selectedId?: string }) {
  const authFetch = useAuthenticatedFetch();
  const [esim, setEsim] = useState<Esim | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [usageNotice, setUsageNotice] = useState('');
  const [refreshing, setRefreshing] = useState(false);
  const [lastRefreshAttempt, setLastRefreshAttempt] = useState(0);
  const [showQr, setShowQr] = useState(false);
  const showQrButtonRef = useRef<HTMLButtonElement>(null);

  const load = useCallback(async () => {
    const response = await authFetch(`${API}/customer/esims${selectedId ? `/${selectedId}` : ''}`, { headers: {} });
    const value = await response.json();
    if (!response.ok) throw new Error(value?.error?.message ?? 'Could not load your eSIM.');
    setEsim(selectedId ? value.data : value.data[0] ?? null);
  }, [authFetch, selectedId]);
  useEffect(() => { setLoading(true); setError(''); void load().catch((cause) => setError(cause instanceof Error ? cause.message : 'Could not load your eSIM.')).finally(() => setLoading(false)); }, [load]);

  const closeQr = useCallback(() => { setShowQr(false); requestAnimationFrame(() => showQrButtonRef.current?.focus()); }, []);
  const refresh = async () => {
    if (!esim || refreshing) return;
    const remaining = REFRESH_COOLDOWN_MS - (Date.now() - lastRefreshAttempt);
    if (remaining > 0) { setUsageNotice(`Usage was just refreshed. Try again in ${Math.ceil(remaining / 1000)} seconds.`); return; }
    setRefreshing(true); setUsageNotice(''); setLastRefreshAttempt(Date.now());
    try {
      const response = await authFetch(`${API}/customer/esims/${esim.id}/usage/refresh`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-idempotency-key': crypto.randomUUID() }, body: '{}' });
      const value = await response.json();
      if (!response.ok) throw new Error(value?.error?.message ?? value?.message ?? 'Usage refresh failed.');
      await load(); setUsageNotice('Usage is up to date.');
    } catch (cause) { setUsageNotice(`${cause instanceof Error ? cause.message : 'Usage refresh failed.'} Your last saved usage is still shown.`); }
    finally { setRefreshing(false); }
  };

  if (loading) return <DashboardSkeleton />;
  if (error && !esim) return <main className="account-page"><div className="shell"><div className="account-empty error-state"><AlertCircle /><h1>We couldn’t load your eSIM</h1><p>{error}</p><button className="button" onClick={() => { setLoading(true); setError(''); void load().catch((cause) => setError(cause instanceof Error ? cause.message : 'Could not load your eSIM.')).finally(() => setLoading(false)); }}>Try again</button></div></div></main>;
  if (!esim) return <main className="account-page"><div className="shell"><div className="account-empty"><QrCode /><h1>Your eSIM will appear here</h1><p>Choose your first destination plan and we’ll add your reusable eSIM to this dashboard.</p><Link className="button" href="/#plans">Browse plans</Link></div></div></main>;

  const active = esim.subscriptions.filter((item) => ['ACTIVE', 'PENDING'].includes(item.status));
  const past = esim.subscriptions.filter((item) => !['ACTIVE', 'PENDING'].includes(item.status));
  const country = active[0]?.plan.countryCode ?? esim.subscriptions[0]?.plan.countryCode ?? '';
  const status = formatStatus(esim);
  return <main className="account-page"><div className="shell"><header className="account-head esim-page-head"><div><span className="eyebrow"><Wifi />Your connectivity</span><h1>My eSIM</h1><p>Install, check data, and add destination plans from one place.</p></div><Link className="text-link" href="/account/orders"><Clock3 />View order history</Link></header>{error && <div className="form-error" role="alert">{error}</div>}<div className="esim-dashboard"><section className="esim-hero-card"><div className="esim-identity"><span className={`friendly-status ${status.tone}`}><i />{status.label}</span><div className="esim-brand"><span><Wifi /></span><div><h2>Visa Compass eSIM</h2><p>{status.detail}</p></div></div><small className="esim-number">{esim.msisdnMasked ?? esim.iccidMasked ?? 'Identifier available after provisioning'}</small></div><div className="esim-actions">{esim.qrOrderId && <button ref={showQrButtonRef} className="button secondary" onClick={() => setShowQr(true)}><QrCode />Show QR</button>}<Link className="button" href={`/?esim=${esim.id}&country=${country}#plans`}><Plus />Add data</Link></div></section><section className="usage-summary battery-summary"><Battery usage={esim.usage} /><div className="usage-copy"><span className="section-kicker">Available data</span><h2>{esim.usage ? `${formatData(esim.usage.usedMb)} used of ${formatData(esim.usage.totalMb)}` : 'Usage appears after activation'}</h2><p>{esim.usage ? `Last updated ${new Date(esim.usage.lastCheckedAt).toLocaleString()}` : 'Once your provider activates the plan, its balance will appear here.'}</p>{usageNotice && <small className="usage-notice" role="status">{usageNotice}</small>}</div><button className="button secondary refresh-button" disabled={refreshing} onClick={() => void refresh()}>{refreshing ? <LoaderCircle className="spin" /> : <RefreshCcw />}Refresh usage</button></section><CurrentPlans plans={active} /><section className="setup-card"><span><HelpCircle /></span><div><h2>Need help installing?</h2><p>Open your phone’s mobile settings, choose Add eSIM, then scan your secure activation QR.</p></div>{esim.qrOrderId && <button className="text-link" onClick={() => setShowQr(true)}>View setup QR</button>}</section>{past.length > 0 && <details className="past-plans"><summary>Previous plans <span>{past.length}</span></summary>{past.map((plan) => <div key={plan.id}><span><b>{plan.plan.name}</b><small>{plan.plan.countryName}</small></span><b>{plan.status === 'EXPIRED' ? 'Expired' : 'Previous'}</b></div>)}</details>}{esim.activity?.length ? <section className="plan-section activity-section"><div className="section-heading"><span><CheckCircle2 /></span><div><h2>Plan activity</h2><p>Purchases and top-ups linked to this eSIM.</p></div></div><div className="activity-list">{esim.activity.map((item) => <Link href={`/account/orders/${item.orderId}`} key={item.orderId}><span><b>{item.planName}</b><small>{item.purchaseType === 'TOPUP' ? 'Top-up' : 'Plan purchase'} · {item.orderNumber}</small></span><span><b>{item.orderStatus.replaceAll('_', ' ').toLowerCase()}</b><small>{new Date(item.createdAt).toLocaleDateString()}</small></span></Link>)}</div></section> : null}</div></div>{showQr && <QrModal esim={esim} authFetch={authFetch} onClose={closeQr} />}</main>;
}
