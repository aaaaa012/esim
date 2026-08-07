'use client';
import { useAuthenticatedFetch } from '../authenticated-api-provider';
import { useEffect, useRef, useState } from 'react';
import {
  AlertTriangle,
  CheckCircle2,
  Clock,
  FileUp,
  LoaderCircle,
  Upload,
  PackageCheck,
  PackageOpen,
  RefreshCcw,
  ShieldCheck,
  XCircle,
} from 'lucide-react';
const API = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:4000/api/v1';
type Batch = {
  id: string;
  batchReference: string;
  totalProfiles: number;
  importedCount: number;
  failedCount: number;
  status: 'PENDING' | 'APPROVED' | 'REJECTED';
  rejectionReason?: string;
  createdAt: string;
};
type Overview = {
  counts: {
    available: number;
    reserved: number;
    assigned: number;
    activated: number;
    pending: number;
  };
  lowStockThreshold: number;
  lowStock: boolean;
  batches: Batch[];
};
type ImportResult = { imported: number; skipped: number; errors?: string[]; batch: string | null };
type Plan = {
  id: string;
  name: string;
  countryCode: string;
  countryName: string;
  dataAllowance: string;
  validityDays: number;
  sellingPriceNpr: number;
  status: 'DRAFT' | 'ACTIVE' | 'DISABLED' | 'ARCHIVED';
};
const fileToTabularContent = async (file: File): Promise<string> => {
  if (/\.xlsx?$/i.test(file.name)) {
    const buffer = await file.arrayBuffer();
    let binary = '';
    const bytes = new Uint8Array(buffer);
    for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]!);
    return btoa(binary);
  }
  return file.text();
};

export default function InventoryClient() {
  const authFetch = useAuthenticatedFetch();
  const [data, setData] = useState<Overview | null>(null),
    [error, setError] = useState(''),
    [iccids, setIccids] = useState(''),
    [source, setSource] = useState(''),
    [importing, setImporting] = useState(false),
    [notice, setNotice] = useState(''),
    [csvFile, setCsvFile] = useState<File | null>(null),
    [csvBusy, setCsvBusy] = useState(false),
    [csvNotice, setCsvNotice] = useState(''),
    [csvErrors, setCsvErrors] = useState<string[]>([]),
    [isSuperAdmin, setIsSuperAdmin] = useState(false),
    [decision, setDecision] = useState(''),
    csvInput = useRef<HTMLInputElement>(null),
    [planFile, setPlanFile] = useState<File | null>(null),
    [planBusy, setPlanBusy] = useState(false),
    [planNotice, setPlanNotice] = useState(''),
    [planErrors, setPlanErrors] = useState<string[]>([]),
    [draftPlans, setDraftPlans] = useState<Plan[]>([]),
    [planDecision, setPlanDecision] = useState(''),
    planCsvInput = useRef<HTMLInputElement>(null);
  const load = () => {
    void authFetch(`${API}/operations/inventory`, { headers: {} })
      .then(async (r) => {
        const v = await r.json();
        if (!r.ok) throw new Error(v.error?.message);
        setData(v.data);
      })
      .catch((e) => setError(e.message));
  };
  useEffect(() => {
    void authFetch(`${API}/auth/me`, { headers: {} })
      .then((r) => r.json())
      .then((v) => {
        const caps = v.data?.effectiveCapabilities ?? [];
        setIsSuperAdmin(caps.includes('admin:portal'));
      })
      .catch(() => undefined);
    load();
    loadPlans();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const submit = async () => {
    const list = iccids.split(/\n|,|;| /).map((s) => s.trim()).filter(Boolean);
    if (!list.length) { setNotice('Paste at least one ICCID'); return; }
    setImporting(true);
    setNotice('');
    try {
      const r = await authFetch(`${API}/operations/inventory/import`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ iccids: list, source: source.trim() || undefined }),
      });
      const v = await r.json();
      if (!r.ok) throw new Error(v.error?.message);
      setNotice(
        `Imported ${v.data.imported} profiles, skipped ${v.data.skipped} duplicate(s). Awaiting Super Admin approval before sale.`,
      );
      setIccids('');
      load();
    } catch (e) {
      setNotice(e instanceof Error ? e.message : 'Import failed');
    } finally {
      setImporting(false);
    }
  };
  const submitCsv = async () => {
    if (!csvFile) { setCsvNotice('Choose a CSV or Excel file first'); return; }
    setCsvBusy(true);
    setCsvNotice('');
    setCsvErrors([]);
    try {
      const content = await fileToTabularContent(csvFile);
      const r = await authFetch(`${API}/operations/inventory/import-csv`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ content, fileName: csvFile.name, source: source.trim() || undefined }),
      });
      const v = await r.json();
      if (!r.ok) throw new Error(v.error?.message);
      const result = v.data as ImportResult;
      setCsvNotice(
        `Imported ${result.imported} profiles, skipped ${result.skipped} row(s). Awaiting Super Admin approval before sale.`,
      );
      setCsvErrors(result.errors ?? []);
      if (result.imported > 0) {
        setCsvFile(null);
        if (csvInput.current) csvInput.current.value = '';
      }
      load();
    } catch (e) {
      setCsvNotice(e instanceof Error ? e.message : 'CSV/Excel import failed');
    } finally {
      setCsvBusy(false);
    }
  };
  const decide = async (batch: Batch, approve: boolean) => {
    setDecision(batch.id);
    setNotice('');
    try {
      const r = await authFetch(
        `${API}/operations/inventory/batches/${batch.id}/${approve ? 'approve' : 'reject'}`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          ...(approve ? {} : { body: JSON.stringify({ reason: 'Rejected by Super Admin' }) }),
        },
      );
      const v = await r.json();
      if (!r.ok) throw new Error(v.error?.message);
      setNotice(
        approve
          ? `Batch ${batch.batchReference} approved; ${batch.importedCount} profile(s) are now sellable`
          : `Batch ${batch.batchReference} rejected; profiles withheld from sale`,
      );
      load();
    } catch (e) {
      setNotice(e instanceof Error ? e.message : 'Decision failed');
    } finally {
      setDecision('');
    }
  };
  const loadPlans = () => {
    void authFetch(`${API}/admin/plans`, { headers: {} })
      .then(async (r) => {
        const v = await r.json();
        if (!r.ok) throw new Error(v.error?.message);
        setDraftPlans((v.data?.plans ?? []).filter((p: Plan) => p.status === 'DRAFT'));
      })
      .catch((e) => setPlanNotice(e.message));
  };
  const submitPlans = async () => {
    if (!planFile) { setPlanNotice('Choose a CSV or Excel file first'); return; }
    setPlanBusy(true);
    setPlanNotice('');
    setPlanErrors([]);
    try {
      const content = await fileToTabularContent(planFile);
      const r = await authFetch(`${API}/admin/plans/import-csv`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ content, fileName: planFile.name }),
      });
      const v = await r.json();
      if (!r.ok) throw new Error(v.error?.message);
      const result = v.data as ImportResult;
      setPlanNotice(
        `Imported ${result.imported} package(s), skipped ${result.skipped} row(s). They are DRAFT; Super Admin approval makes them sellable.`,
      );
      setPlanErrors(result.errors ?? []);
      if (result.imported > 0) {
        setPlanFile(null);
        if (planCsvInput.current) planCsvInput.current.value = '';
      }
      loadPlans();
    } catch (e) {
      setPlanNotice(e instanceof Error ? e.message : 'Package import failed');
    } finally {
      setPlanBusy(false);
    }
  };
  const decidePlan = async (plan: Plan, approve: boolean) => {
    setPlanDecision(plan.id);
    setPlanNotice('');
    try {
      const r = await authFetch(`${API}/admin/plans/${plan.id}/${approve ? 'approve' : 'reject'}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
      });
      const v = await r.json();
      if (!r.ok) throw new Error(v.error?.message);
      setPlanNotice(
        approve ? `Package "${plan.name}" approved and now sellable` : `Package "${plan.name}" rejected`,
      );
      loadPlans();
    } catch (e) {
      setPlanNotice(e instanceof Error ? e.message : 'Package decision failed');
    } finally {
      setPlanDecision('');
    }
  };
  if (!data) return <div className="empty-table">{error || <><LoaderCircle className="spin" />Loading inventory…</>}</div>;
  const metrics = [
    ['Available', data.counts.available, PackageOpen],
    ['Pending approval', data.counts.pending, Clock],
    ['Reserved', data.counts.reserved, RefreshCcw],
    ['Assigned', data.counts.assigned, PackageCheck],
    ['Activated', data.counts.activated, CheckCircle2],
  ] as const;
  const pendingBatches = data.batches.filter((batch) => batch.status === 'PENDING');
  return (
    <>
      <div className="top">
        <div>
          <h1>eSIM inventory</h1>
          <p>Uploads go to pending review; Super Admin approval releases profiles for sale.</p>
        </div>
        <span className={`stock-state ${data.lowStock ? 'low' : 'healthy'}`}>
          {data.lowStock ? <AlertTriangle size={15} /> : <CheckCircle2 size={15} />}
          {data.lowStock ? 'Low stock' : 'Stock healthy'}
        </span>
      </div>
      <section className="grid">
        {metrics.map(([label, value, Icon]) => (
          <article className="metric" key={label}>
            <span className="metric-label">{label}</span>
            <div className="metric-row">
              <strong>{value}</strong>
              <span className="icon"><Icon size={18} /></span>
            </div>
          </article>
        ))}
      </section>
      <div className="threshold-note">
        Low-stock alert triggers at {data.lowStockThreshold} available profiles.
        {data.counts.pending > 0 && !isSuperAdmin && (
          <span> · {data.counts.pending} profile(s) await Super Admin approval.</span>
        )}
      </div>
      <section className="panel">
        <div className="panel-head">
          <h2>Pending approvals</h2>
          <span>Super Admin must approve every upload before it becomes sellable</span>
        </div>
        {pendingBatches.length === 0 ? (
          <p className="catalog-empty">No batches are awaiting approval.</p>
        ) : (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Batch</th>
                  <th>Profiles</th>
                  <th>Uploaded</th>
                  <th>Decision</th>
                </tr>
              </thead>
              <tbody>
                {pendingBatches.map((batch) => (
                  <tr key={batch.id}>
                    <td>
                      <b>{batch.batchReference}</b>
                      <small>{batch.id}</small>
                    </td>
                    <td>{batch.importedCount}</td>
                    <td>{new Date(batch.createdAt).toLocaleString()}</td>
                    <td>
                      {isSuperAdmin ? (
                        <div className="import-actions">
                          <button
                            className="approve"
                            disabled={decision === batch.id}
                            onClick={() => void decide(batch, true)}
                          >
                            {decision === batch.id ? <LoaderCircle className="spin" size={15} /> : <CheckCircle2 size={15} />}
                            Approve
                          </button>
                          <button
                            className="reject"
                            disabled={decision === batch.id}
                            onClick={() => void decide(batch, false)}
                          >
                            <XCircle size={15} />
                            Reject
                          </button>
                        </div>
                      ) : (
                        <span className="health-badge warning">
                          <ShieldCheck size={13} /> Awaiting Super Admin
                        </span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
      <section className="panel">
        <div className="panel-head">
          <h2>Import ICCIDs</h2>
          <span>Paste Transatel ICCID inventory</span>
        </div>
        <div className="import-form">
          <textarea
            rows={5}
            placeholder={'Paste ICCIDs, one per line, e.g.\n899770100000000001\n899770100000000002'}
            value={iccids}
            onChange={(e) => setIccids(e.target.value)}
          />
          <div className="import-actions">
            <input placeholder="Source (e.g. batch reference)" value={source} onChange={(e) => setSource(e.target.value)} />
            <button onClick={submit} disabled={importing || !iccids.trim()}>
              {importing ? <LoaderCircle className="spin" size={15} /> : <Upload size={15} />} Import
            </button>
          </div>
          {notice && <div className="import-notice">{notice}</div>}
        </div>
      </section>
      <section className="panel">
        <div className="panel-head">
          <h2>Bulk upload profiles (CSV / Excel)</h2>
          <span>Columns: iccid, eid (optional), msisdn (optional)</span>
        </div>
        <div className="import-form">
          <input ref={csvInput} type="file" accept=".csv,.xlsx,.xls,text/csv" onChange={(e) => setCsvFile(e.target.files?.[0] ?? null)} />
          <div className="import-actions">
            <button onClick={submitCsv} disabled={csvBusy || !csvFile}>
              {csvBusy ? <LoaderCircle className="spin" size={15} /> : <FileUp size={15} />} Upload file
            </button>
          </div>
          {csvNotice && <div className="import-notice">{csvNotice}</div>}
          {csvErrors.length > 0 && (
            <div className="csv-error-detail">
              {csvErrors.slice(0, 20).join(' · ')}
              {csvErrors.length > 20 && ` (+${csvErrors.length - 20} more)`}
            </div>
          )}
        </div>
      </section>
      <section className="panel">
        <div className="panel-head">
          <h2>Bulk upload packages (CSV / Excel)</h2>
          <span>Columns: countryIso2, name, providerPlanId, dataAllowance, validityDays, costPrice, sellingPrice (currency, popular, status optional)</span>
        </div>
        <div className="import-form">
          <input
            ref={planCsvInput}
            type="file"
            accept=".csv,.xlsx,.xls,text/csv"
            onChange={(e) => setPlanFile(e.target.files?.[0] ?? null)}
          />
          <div className="import-actions">
            <button onClick={submitPlans} disabled={planBusy || !planFile}>
              {planBusy ? <LoaderCircle className="spin" size={15} /> : <PackageCheck size={15} />} Upload packages
            </button>
          </div>
          {planNotice && <div className="import-notice">{planNotice}</div>}
          {planErrors.length > 0 && (
            <div className="csv-error-detail">
              {planErrors.slice(0, 20).join(' · ')}
              {planErrors.length > 20 && ` (+${planErrors.length - 20} more)`}
            </div>
          )}
        </div>
      </section>
      <section className="panel">
        <div className="panel-head">
          <h2>Packages awaiting approval</h2>
          <span>Uploaded packages are DRAFT; Super Admin approval releases them for sale</span>
        </div>
        {draftPlans.length === 0 ? (
          <p className="catalog-empty">No packages are awaiting approval.</p>
        ) : (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Package</th>
                  <th>Country</th>
                  <th>Data</th>
                  <th>Price (NPR)</th>
                  <th>Decision</th>
                </tr>
              </thead>
              <tbody>
                {draftPlans.map((plan) => (
                  <tr key={plan.id}>
                    <td>
                      <b>{plan.name}</b>
                      <small>{plan.id}</small>
                    </td>
                    <td>{plan.countryCode} · {plan.countryName}</td>
                    <td>{plan.dataAllowance} / {plan.validityDays} days</td>
                    <td>Rs {plan.sellingPriceNpr}</td>
                    <td>
                      {isSuperAdmin ? (
                        <div className="import-actions">
                          <button
                            className="approve"
                            disabled={planDecision === plan.id}
                            onClick={() => void decidePlan(plan, true)}
                          >
                            {planDecision === plan.id ? <LoaderCircle className="spin" size={15} /> : <CheckCircle2 size={15} />}
                            Approve
                          </button>
                          <button
                            className="reject"
                            disabled={planDecision === plan.id}
                            onClick={() => void decidePlan(plan, false)}
                          >
                            <XCircle size={15} />
                            Reject
                          </button>
                        </div>
                      ) : (
                        <span className="health-badge warning">
                          <ShieldCheck size={13} /> Awaiting Super Admin
                        </span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
      <section className="panel">
        <div className="panel-head">
          <h2>Recent batches</h2>
          <span>Traceability for every upload</span>
        </div>
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Reference</th>
                <th>Profiles</th>
                <th>Status</th>
                <th>Uploaded</th>
              </tr>
            </thead>
            <tbody>
              {data.batches.slice(0, 15).map((batch) => (
                <tr key={batch.id}>
                  <td><b>{batch.batchReference}</b></td>
                  <td>{batch.importedCount} / {batch.totalProfiles}</td>
                  <td>
                    <span className={`health-badge ${batch.status === 'APPROVED' ? 'healthy' : batch.status === 'REJECTED' ? 'warning' : ''}`}>
                      {batch.status.replace('_', ' ')}
                    </span>
                    {batch.rejectionReason && <small> {batch.rejectionReason}</small>}
                  </td>
                  <td>{new Date(batch.createdAt).toLocaleString()}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
    </>
  );
}
