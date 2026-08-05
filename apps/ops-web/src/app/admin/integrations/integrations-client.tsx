"use client";
import { useAuthenticatedFetch } from "../../authenticated-api-provider";
import { useEffect, useState } from "react";
import {
  FlaskConical,
  History,
  LoaderCircle,
  Pencil,
  RefreshCcw,
  Settings2,
  ShieldCheck,
} from "lucide-react";
const API = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:4000/api/v1";
const headers = { "content-type": "application/json" };
type Integration = {
  id: string;
  name: string;
  category: string;
  provider: string;
  enabled: boolean;
  status: string;
  secretValue: string;
  checkedAt: string;
};
type Plan = {
  id: string;
  countryCode: string;
  name: string;
};
type IntegrationLog = {
  id: string;
  operation: string;
  method: string;
  endpoint: string;
  status: string;
  durationMs?: number;
  errorCode?: string;
  errorMessage?: string;
  createdAt: string;
};
export default function IntegrationsClient() {
  const authFetch = useAuthenticatedFetch();
  const request = async <T,>(path: string, init?: RequestInit) => {
    const r = await authFetch(`${API}${path}`, {
      ...init,
      headers: { ...headers, ...init?.headers },
    });
    const v = await r.json();
    if (!r.ok) throw new Error(v.error?.message ?? "Request failed");
    return v.data as T;
  };
  const [integrations, setIntegrations] = useState<Integration[]>([]);
  const [plans, setPlans] = useState<Plan[]>([]);
  const [logs, setLogs] = useState<IntegrationLog[]>([]);
  const [busy, setBusy] = useState("");
  const [notice, setNotice] = useState("");
  const [eligibilityPlanId, setEligibilityPlanId] = useState("");
  const [eligibilityMsisdn, setEligibilityMsisdn] = useState("");
  const [logsBusy, setLogsBusy] = useState(false);
  const load = () =>
    Promise.all([
      request<Integration[]>("/admin/integrations"),
      request<Plan[]>("/admin/plans"),
      request<IntegrationLog[]>("/operations/integration-logs"),
    ])
      .then(([i, p, l]) => {
        setIntegrations(i);
        setPlans(p);
        setLogs(l);
      })
      .catch((e) => setNotice(e.message));
  useEffect(() => {
    void load();
  }, []);
  const test = async (item: Integration) => {
    setBusy(item.id);
    try {
      const result = await request<{ message: string }>(
        `/admin/integrations/${item.id}/test`,
        { method: "POST" },
      );
      setNotice(result.message);
    } catch (e) {
      setNotice(e instanceof Error ? e.message : "Test failed");
    } finally {
      setBusy("");
    }
  };
  const transatelAction = async (action: "sync-catalog" | "ensure-webhook") => {
    setBusy(`transatel:${action}`);
    try {
      const result = await request<Record<string, unknown>>(
        `/admin/integrations/transatel/${action}`,
        { method: "POST" },
      );
      setNotice(
        JSON.stringify(result, null, 2).slice(0, 400) ||
          `${action.replace("-", " ")} complete`,
      );
    } catch (e) {
      setNotice(e instanceof Error ? e.message : `${action} failed`);
    } finally {
      setBusy("");
    }
  };
  const checkEligibility = async () => {
    if (!eligibilityPlanId || !eligibilityMsisdn) {
      setNotice("Choose a plan and enter an MSISDN first");
      return;
    }
    setBusy("transatel:eligibility");
    try {
      const result = await request<Record<string, unknown>>(
        "/admin/integrations/transatel/eligibility",
        {
          method: "POST",
          body: JSON.stringify({ planId: eligibilityPlanId, msisdn: eligibilityMsisdn }),
        },
      );
      setNotice(JSON.stringify(result, null, 2).slice(0, 400) || "Eligibility check complete");
    } catch (e) {
      setNotice(e instanceof Error ? e.message : "Eligibility check failed");
    } finally {
      setBusy("");
    }
  };
  const refreshLogs = async () => {
    setLogsBusy(true);
    try {
      setLogs(await request<IntegrationLog[]>("/operations/integration-logs"));
    } catch (e) {
      setNotice(e instanceof Error ? e.message : "Could not load integration logs");
    } finally {
      setLogsBusy(false);
    }
  };
  return (
    <>
      <div className="admin-title">
        <div>
          <h1>Integration health</h1>
          <p>
            Live status is shown without exposing stored secrets. Credentials
            are managed as environment/secret values.
          </p>
        </div>
        <span>
          <ShieldCheck size={16} />
          Super Admin access
        </span>
      </div>
      {notice && (
        <button className="admin-notice" onClick={() => setNotice("")}>
          {notice}
          <span>×</span>
        </button>
      )}
      {!integrations.length ? (
        <div className="admin-loading">
          <LoaderCircle className="spin" />
          Loading secure configuration…
        </div>
      ) : (
        <div className="integration-grid">
          {integrations.map((item) => (
            <article className="integration-card" key={item.id}>
              <div className="integration-head">
                <span className="integration-icon">
                  <Settings2 size={18} />
                </span>
                <div>
                  <h2>{item.name}</h2>
                  <small>
                    {item.category} · {item.provider}
                  </small>
                </div>
                <b
                  className={`health-badge ${item.status === "HEALTHY" ? "healthy" : "warning"}`}
                >
                  {item.status.replaceAll("_", " ")}
                </b>
              </div>
              <div className="integration-enabled">
                <span>{item.enabled ? "Enabled" : "Environment setup required"}</span>
                <code>{item.secretValue}</code>
              </div>
              <small>Last checked: {new Date(item.checkedAt).toLocaleString()}</small>
              <div className="integration-actions">
                <button
                  onClick={() => setNotice(`${item.name}: set ${item.provider} credentials as environment/secret values, then restart the API.`)}
                >
                  <Pencil size={15} />
                  Credential guidance
                </button>
                <button onClick={() => test(item)} disabled={busy === item.id}>
                  {busy === item.id ? <LoaderCircle className="spin" size={15} /> : <FlaskConical size={15} />}
                  Test
                </button>
                {item.id === "transatel" && (
                  <>
                    <button onClick={() => transatelAction("sync-catalog")} disabled={busy === "transatel:sync-catalog"}>
                      {busy === "transatel:sync-catalog" ? <LoaderCircle className="spin" size={15} /> : <RefreshCcw size={15} />}
                      Sync catalog
                    </button>
                    <button onClick={() => transatelAction("ensure-webhook")} disabled={busy === "transatel:ensure-webhook"}>
                      {busy === "transatel:ensure-webhook" ? <LoaderCircle className="spin" size={15} /> : <Pencil size={15} />}
                      Register webhook
                    </button>
                    <div className="eligibility-box">
                      <b>Eligibility check</b>
                      <div className="config-row">
                        <select value={eligibilityPlanId} onChange={(e) => setEligibilityPlanId(e.target.value)}>
                          <option value="">Select plan…</option>
                          {plans.map((plan) => (
                            <option key={plan.id} value={plan.id}>
                              {plan.countryCode} · {plan.name}
                            </option>
                          ))}
                        </select>
                        <input
                          placeholder="MSISDN, e.g. 97798…"
                          value={eligibilityMsisdn}
                          onChange={(e) => setEligibilityMsisdn(e.target.value)}
                        />
                        <button className="admin-action" disabled={busy === "transatel:eligibility"} onClick={() => void checkEligibility()}>
                          Check
                        </button>
                      </div>
                    </div>
                  </>
                )}
              </div>
            </article>
          ))}
        </div>
      )}
      <section className="config-panel" style={{ marginTop: 22 }}>
        <div className="admin-section-head">
          <div>
            <h2>Integration call log</h2>
            <p>Outbound integration requests and outcomes (most recent 200).</p>
          </div>
          <button className="admin-action" onClick={() => void refreshLogs()} disabled={logsBusy}>
            {logsBusy ? <LoaderCircle className="spin" size={15} /> : <History size={15} />}
            Refresh
          </button>
        </div>
        {!logs.length ? (
          <p className="catalog-empty">No integration calls recorded yet.</p>
        ) : (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Time</th>
                  <th>Operation</th>
                  <th>Endpoint</th>
                  <th>Status</th>
                  <th>Duration</th>
                  <th>Error</th>
                </tr>
              </thead>
              <tbody>
                {logs.map((log) => (
                  <tr key={log.id}>
                    <td><small>{new Date(log.createdAt).toLocaleString()}</small></td>
                    <td>{log.operation}</td>
                    <td><code>{log.method} {log.endpoint}</code></td>
                    <td>
                      <span className={`health-badge ${log.status === "SUCCESS" ? "healthy" : "warning"}`}>{log.status}</span>
                    </td>
                    <td>{log.durationMs != null ? `${log.durationMs}ms` : "—"}</td>
                    <td><small>{log.errorMessage ?? log.errorCode ?? "—"}</small></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </>
  );
}