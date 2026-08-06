"use client";
import { useAuthenticatedFetch } from "../authenticated-api-provider";
import { useEffect, useState } from "react";
import {
  CheckCircle2,
  FlaskConical,
  History,
  LoaderCircle,
  Pencil,
  RefreshCcw,
  Save,
  Settings2,
  ShieldCheck,
  Upload,
  UsersRound,
  XCircle,
} from "lucide-react";
const API = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:4000/api/v1";
const headers = {
  "content-type": "application/json",
};
type Plan = {
  id: string;
  name: string;
  countryCode: string;
  countryName: string;
  dataAllowance: string;
  validityDays: number;
  sellingPriceNpr: number;
  costPriceNpr: number;
  currency: string;
  popular: boolean;
  status: "DRAFT" | "ACTIVE" | "DISABLED" | "ARCHIVED";
};
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
type User = {
  id: string;
  clerkId: string;
  email: string;
  status: "ACTIVE" | "DISABLED";
  accountType: "CUSTOMER" | "OPERATIONS" | "SUPER_ADMIN";
  effectiveCapabilities: string[];
  customerCode?: string;
  createdAt: string;
};
type Invitation = {
  id: string;
  email: string;
  accountType: "OPERATIONS" | "SUPER_ADMIN";
  status: string;
  expiresAt: string;
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
const tabs = [
  "Plans",
  "Pricing",
  "Integrations",
  "Document Rules",
  "Inventory Settings",
  "Users",
  "System Config",
];

const fileToTabularContent = async (file: File): Promise<string> => {
  if (/\.xlsx?$/i.test(file.name)) {
    const buffer = await file.arrayBuffer();
    let binary = "";
    const bytes = new Uint8Array(buffer);
    for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]!);
    return btoa(binary);
  }
  return file.text();
};
export default function AdminWorkspace() {
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
  const [tab, setTab] = useState("Plans"),
    [plans, setPlans] = useState<Plan[]>([]),
    [integrations, setIntegrations] = useState<Integration[]>([]),
    [users, setUsers] = useState<User[]>([]),
    [invitations, setInvitations] = useState<Invitation[]>([]),
    [inviteEmail, setInviteEmail] = useState(""),
    [inviteType, setInviteType] = useState<"OPERATIONS" | "SUPER_ADMIN">(
      "OPERATIONS",
    ),
    [busy, setBusy] = useState(""),
    [notice, setNotice] = useState(""),
    [planCsvFile, setPlanCsvFile] = useState<File | null>(null),
    [planCsvBusy, setPlanCsvBusy] = useState(false),
    [planCsvResult, setPlanCsvResult] = useState("");
    const [planCsvErrors, setPlanCsvErrors] = useState<string[]>([]);
  const [eligibilityPlanId, setEligibilityPlanId] = useState("");
  const [eligibilityMsisdn, setEligibilityMsisdn] = useState("");
  const [logs, setLogs] = useState<IntegrationLog[]>([]);
  const [logsBusy, setLogsBusy] = useState(false);
  const load = () =>
    Promise.all([
      request<Plan[]>("/admin/plans"),
      request<Integration[]>("/admin/integrations"),
      request<User[]>("/admin/users"),
      request<Invitation[]>("/admin/staff-invitations"),
    ])
      .then(([p, i, u, invitationsValue]) => {
        setPlans(p);
        setIntegrations(i);
        setUsers(u);
        setInvitations(invitationsValue);
      })
      .catch((e) => setNotice(e.message));
  useEffect(() => {
    void load();
  }, []);
  const savePlan = async (plan: Plan) => {
    setBusy(plan.id);
    try {
      const updated = await request<Plan>(`/admin/plans/${plan.id}`, {
        method: "PATCH",
        body: JSON.stringify({
          sellingPriceNpr: plan.sellingPriceNpr,
          popular: plan.popular,
          status: plan.status,
        }),
      });
      setPlans((v) =>
        v.map((item) => (item.id === updated.id ? updated : item)),
      );
      setNotice(`${updated.name} saved`);
    } catch (e) {
      setNotice(e instanceof Error ? e.message : "Save failed");
    } finally {
      setBusy("");
    }
  };
  const reviewPlan = async (plan: Plan, approve: boolean) => {
    setBusy(`${plan.id}:${approve ? "approve" : "reject"}`);
    try {
      const updated = await request<Plan>(
        `/admin/plans/${plan.id}/${approve ? "approve" : "reject"}`,
        { method: "POST", body: JSON.stringify({ reason: approve ? undefined : "Rejected by Super Admin" }) },
      );
      setPlans((v) =>
        v.map((item) => (item.id === updated.id ? updated : item)),
      );
      setNotice(
        approve
          ? `${updated.name} approved and now visible to customers`
          : `${updated.name} rejected and archived`,
      );
    } catch (e) {
      setNotice(e instanceof Error ? e.message : "Review failed");
    } finally {
      setBusy("");
    }
  };
  const importPlanCsv = async () => {
    if (!planCsvFile) {
      setPlanCsvResult("Choose a CSV or Excel file first");
      return;
    }
    setPlanCsvBusy(true);
    setPlanCsvResult("");
    setPlanCsvErrors([]);
    try {
      const content = await fileToTabularContent(planCsvFile);
      const result = await request<{
        imported: number;
        updated: number;
        skipped: number;
        errors: string[];
      }>("/admin/plans/import-csv", {
        method: "POST",
        body: JSON.stringify({ content, fileName: planCsvFile.name }),
      });
      setPlanCsvResult(
        `Imported ${result.imported}, updated ${result.updated}, skipped ${result.skipped} row(s)`,
      );
      setPlanCsvErrors(result.errors ?? []);
      await load();
    } catch (e) {
      setPlanCsvResult(e instanceof Error ? e.message : "CSV import failed");
    } finally {
      setPlanCsvBusy(false);
    }
  };
  const test = async (item: Integration) => {
    setBusy(item.id);
    const result = await request<{ message: string }>(
      `/admin/integrations/${item.id}/test`,
      { method: "POST" },
    );
    setNotice(result.message);
    setBusy("");
  };
  const transatelAction = async (
    action: "sync-catalog" | "ensure-webhook",
  ) => {
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
  const inviteStaff = async () => {
    setBusy("invite");
    try {
      const result = await request<{ email: string; accountType: string; temporaryPassword: string }>(
        "/admin/staff-invitations",
        {
          method: "POST",
          body: JSON.stringify({ email: inviteEmail, accountType: inviteType }),
        },
      );
      setInviteEmail("");
      await load();
      setNotice(
        `Account created for ${result.email}. One-time password: ${result.temporaryPassword} — share it securely; the staff member should change it after signing in.`,
      );
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "Invitation failed");
    } finally {
      setBusy("");
    }
  };
  const saveUser = async (user: User) => {
    setBusy(user.id);
    try {
      let updated = user;
      if (user.accountType !== "CUSTOMER")
        updated = await request<User>(`/admin/users/${user.id}/account-type`, {
          method: "PATCH",
          body: JSON.stringify({ accountType: user.accountType }),
        });
      await request(`/admin/users/${user.id}/status`, {
        method: "PATCH",
        body: JSON.stringify({ status: user.status }),
      });
      setUsers((v) =>
        v.map((item) => (item.id === updated.id ? updated : item)),
      );
      setNotice(`Account updated for ${user.email}`);
    } catch (e) {
      setNotice(e instanceof Error ? e.message : "Account update failed");
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
          body: JSON.stringify({
            planId: eligibilityPlanId,
            msisdn: eligibilityMsisdn,
          }),
        },
      );
      setNotice(
        JSON.stringify(result, null, 2).slice(0, 400) ||
          "Eligibility check complete",
      );
    } catch (e) {
      setNotice(e instanceof Error ? e.message : "Eligibility check failed");
    } finally {
      setBusy("");
    }
  };
  const loadLogs = async () => {
    setLogsBusy(true);
    try {
      setLogs(await request<IntegrationLog[]>("/operations/integration-logs"));
    } catch (e) {
      setNotice(
        e instanceof Error ? e.message : "Could not load integration logs",
      );
    } finally {
      setLogsBusy(false);
    }
  };
  useEffect(() => {
    if (tab === "Integrations") void loadLogs();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab]);
  return (
    <>
      <div className="admin-title">
        <div>
          <h1>Administration</h1>
          <p>
            Manage plans, pricing, integrations, document rules, inventory
            settings, users, and system configuration.
          </p>
        </div>
        <span>
          <ShieldCheck size={16} />
          Super Admin access
        </span>
      </div>
      <nav className="admin-tabs">
        {tabs.map((item) => (
          <button
            key={item}
            className={tab === item ? "active" : ""}
            onClick={() => setTab(item)}
          >
            {item}
          </button>
        ))}
      </nav>
      {notice && (
        <button className="admin-notice" onClick={() => setNotice("")}>
          {notice}
          <span>×</span>
        </button>
      )}
      {!plans.length && !integrations.length ? (
        <div className="admin-loading">
          <LoaderCircle className="spin" />
          Loading secure configuration…
        </div>
      ) : (
        <>
          {(tab === "Plans" || tab === "Pricing") && (
            <div className="plans-table">
              <div className="admin-section-head">
                <div>
                  <h2>
                    {tab === "Plans" ? "Plan catalogue" : "Pricing management"}
                  </h2>
                  <p>Changes affect new immutable order quotes only.</p>
                </div>
                <div className="plan-csv-upload">
                  <input
                    type="file"
                    accept=".csv,.xlsx,.xls,text/csv"
                    onChange={(e) => setPlanCsvFile(e.target.files?.[0] ?? null)}
                  />
                  <button
                    onClick={() => void importPlanCsv()}
                    disabled={planCsvBusy || !planCsvFile}
                  >
                    {planCsvBusy ? (
                      <LoaderCircle className="spin" size={15} />
                    ) : (
                      <Upload size={15} />
                    )}
                    Upload CSV
                  </button>
                  {planCsvResult && (
                    <span className={planCsvErrors.length ? "csv-error" : "csv-ok"}>
                      {planCsvResult}
                    </span>
                  )}
                  {planCsvErrors.length > 0 && (
                    <span className="csv-error-detail">
                      {planCsvErrors.slice(0, 20).join(" · ")}
                      {planCsvErrors.length > 20 &&
                        ` (+${planCsvErrors.length - 20} more)`}
                    </span>
                  )}
                </div>
              </div>
              <div className="table-wrap">
                <table>
                  <thead>
                    <tr>
                      <th>Plan</th>
                      <th>Package</th>
                      <th>Cost</th>
                      <th>Selling price</th>
                      <th>Visibility</th>
                      <th>Popular</th>
                      <th></th>
                    </tr>
                  </thead>
                  <tbody>
                    {plans.map((plan) => (
                      <tr key={plan.id}>
                        <td>
                          <b>
                            {plan.countryCode} · {plan.name}
                          </b>
                          <small>{plan.countryName}</small>
                        </td>
                        <td>
                          {plan.dataAllowance} · {plan.validityDays} days
                        </td>
                        <td>NPR {plan.costPriceNpr.toLocaleString()}</td>
                        <td>
                          <input
                            className="price-input"
                            type="number"
                            value={plan.sellingPriceNpr}
                            onChange={(e) =>
                              setPlans((v) =>
                                v.map((item) =>
                                  item.id === plan.id
                                    ? {
                                        ...item,
                                        sellingPriceNpr: Number(e.target.value),
                                      }
                                    : item,
                                ),
                              )
                            }
                          />
                        </td>
                        <td>
                          <select
                            value={plan.status}
                            onChange={(e) =>
                              setPlans((v) =>
                                v.map((item) =>
                                  item.id === plan.id
                                    ? {
                                        ...item,
                                        status: e.target
                                          .value as Plan["status"],
                                      }
                                    : item,
                                ),
                              )
                            }
                          >
                            <option>ACTIVE</option>
                            <option>DISABLED</option>
                            <option>DRAFT</option>
                            <option>ARCHIVED</option>
                          </select>
                        </td>
                        <td>
                          <Toggle
                            value={plan.popular}
                            onChange={() =>
                              setPlans((v) =>
                                v.map((item) =>
                                  item.id === plan.id
                                    ? { ...item, popular: !item.popular }
                                    : item,
                                ),
                              )
                            }
                          />
                        </td>
                        <td>
                          <div className="integration-actions" style={{ justifyContent: "flex-end" }}>
                            {plan.status === "DRAFT" && (
                              <>
                                <button
                                  className="approve"
                                  disabled={busy === `${plan.id}:approve`}
                                  onClick={() => void reviewPlan(plan, true)}
                                >
                                  {busy === `${plan.id}:approve` ? (
                                    <LoaderCircle className="spin" size={15} />
                                  ) : (
                                    <CheckCircle2 size={15} />
                                  )}
                                  Approve
                                </button>
                                <button
                                  className="reject"
                                  disabled={busy === `${plan.id}:reject`}
                                  onClick={() => void reviewPlan(plan, false)}
                                >
                                  <XCircle size={15} />
                                  Reject
                                </button>
                              </>
                            )}
                            <button
                              className="admin-action"
                              disabled={busy === plan.id}
                              onClick={() => savePlan(plan)}
                            >
                              {busy === plan.id ? (
                                <LoaderCircle className="spin" size={15} />
                              ) : (
                                <Save size={15} />
                              )}
                              Save
                            </button>
                          </div>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}
          {tab === "Integrations" && (
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
                    <span>
                      {item.enabled ? "Enabled" : "Environment setup required"}
                    </span>
                    <code>{item.secretValue}</code>
                  </div>
                  <small>
                    Last checked: {new Date(item.checkedAt).toLocaleString()}
                  </small>
                  <div className="integration-actions">
                    <button
                      onClick={() =>
                        setNotice(
                          `Set ${item.provider} credentials as environment/secret values, then restart the API. They are never returned to this UI.`,
                        )
                      }
                    >
                      <Pencil size={15} />
                      Credential guidance
                    </button>
                    <button
                      onClick={() => test(item)}
                      disabled={busy === item.id}
                    >
                      {busy === item.id ? (
                        <LoaderCircle className="spin" size={15} />
                      ) : (
                        <FlaskConical size={15} />
                      )}
                      Test
                    </button>
                    {item.id === "transatel" && (
                      <>
                        <button
                          onClick={() => transatelAction("sync-catalog")}
                          disabled={busy === "transatel:sync-catalog"}
                        >
                          {busy === "transatel:sync-catalog" ? (
                            <LoaderCircle className="spin" size={15} />
                          ) : (
                            <RefreshCcw size={15} />
                          )}
                          Sync catalog
                        </button>
                        <button
                          onClick={() => transatelAction("ensure-webhook")}
                          disabled={busy === "transatel:ensure-webhook"}
                        >
                          {busy === "transatel:ensure-webhook" ? (
                            <LoaderCircle className="spin" size={15} />
                          ) : (
                            <Pencil size={15} />
                          )}
                          Register webhook
                        </button>
                        <div className="eligibility-box">
                          <b>Eligibility check</b>
                          <small>
                            Confirm a plan works for a subscriber MSISDN before
                            approval.
                          </small>
                          <div className="config-row">
                            <select
                              value={eligibilityPlanId}
                              onChange={(event) =>
                                setEligibilityPlanId(event.target.value)
                              }
                            >
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
                              onChange={(event) =>
                                setEligibilityMsisdn(event.target.value)
                              }
                            />
                            <button
                              className="admin-action"
                              disabled={busy === "transatel:eligibility"}
                              onClick={() => void checkEligibility()}
                            >
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
          {tab === "Integrations" && (
            <section className="config-panel">
              <div className="admin-section-head">
                <div>
                  <h2>Integration call log</h2>
                  <p>
                    Outbound integration requests and outcomes (most recent 200).
                  </p>
                </div>
                <button
                  className="admin-action"
                  onClick={() => void loadLogs()}
                  disabled={logsBusy}
                >
                  {logsBusy ? (
                    <LoaderCircle className="spin" size={15} />
                  ) : (
                    <History size={15} />
                  )}
                  Refresh
                </button>
              </div>
              {!logs.length ? (
                <p className="catalog-empty">
                  No integration calls recorded yet.
                </p>
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
                          <td>
                            <small>
                              {new Date(log.createdAt).toLocaleString()}
                            </small>
                          </td>
                          <td>{log.operation}</td>
                          <td>
                            <code>
                              {log.method} {log.endpoint}
                            </code>
                          </td>
                          <td>
                            <span
                              className={`health-badge ${log.status === "SUCCESS" ? "healthy" : "warning"}`}
                            >
                              {log.status}
                            </span>
                          </td>
                          <td>
                            {log.durationMs != null
                              ? `${log.durationMs}ms`
                              : "—"}
                          </td>
                          <td>
                            <small>
                              {log.errorMessage ?? log.errorCode ?? "—"}
                            </small>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </section>
          )}
          {tab === "Users" && (
            <div className="plans-table">
              <div className="admin-section-head">
                <div>
                  <h2>Users and account types</h2>
                  <p>
                    Assign least-privilege access. Role changes are persisted
                    transactionally.
                  </p>
                </div>
                <UsersRound />
              </div>
              <div className="config-row">
                <input
                  type="email"
                  placeholder="Staff email"
                  value={inviteEmail}
                  onChange={(event) => setInviteEmail(event.target.value)}
                />
                <select
                  value={inviteType}
                  onChange={(event) =>
                    setInviteType(event.target.value as typeof inviteType)
                  }
                >
                  <option>OPERATIONS</option>
                  <option>SUPER_ADMIN</option>
                </select>
                <button
                  className="admin-action"
                  disabled={!inviteEmail || busy === "invite"}
                  onClick={inviteStaff}
                >
                  Invite staff
                </button>
              </div>
              {invitations
                .filter((item) => item.status === "PENDING")
                .map((item) => (
                  <div className="config-row" key={item.id}>
                    <span>
                      <b>{item.email}</b>
                      <small>
                        {item.accountType.replace("_", " ")} · expires{" "}
                        {new Date(item.expiresAt).toLocaleDateString()}
                      </small>
                    </span>
                    <span className="health-badge warning">PENDING</span>
                  </div>
                ))}
              <div className="table-wrap">
                <table>
                  <thead>
                    <tr>
                      <th>User</th>
                      <th>Status</th>
                      <th>Customer</th>
                      <th>Account type</th>
                      <th></th>
                    </tr>
                  </thead>
                  <tbody>
                    {users.map((user) => (
                      <tr key={user.id}>
                        <td>
                          <b>{user.email}</b>
                          <small>{user.clerkId}</small>
                        </td>
                        <td>
                          <select
                            value={user.status}
                            onChange={(event) =>
                              setUsers((values) =>
                                values.map((item) =>
                                  item.id === user.id
                                    ? {
                                        ...item,
                                        status: event.target
                                          .value as User["status"],
                                      }
                                    : item,
                                ),
                              )
                            }
                          >
                            <option>ACTIVE</option>
                            <option>DISABLED</option>
                          </select>
                        </td>
                        <td>{user.customerCode ?? "—"}</td>
                        <td>
                          <select
                            disabled={user.accountType === "CUSTOMER"}
                            value={user.accountType}
                            onChange={(event) =>
                              setUsers((values) =>
                                values.map((item) =>
                                  item.id === user.id
                                    ? {
                                        ...item,
                                        accountType: event.target
                                          .value as User["accountType"],
                                      }
                                    : item,
                                ),
                              )
                            }
                          >
                            <option>CUSTOMER</option>
                            <option>OPERATIONS</option>
                            <option>SUPER_ADMIN</option>
                          </select>
                        </td>
                        <td>
                          <button
                            className="admin-action"
                            disabled={busy === user.id}
                            onClick={() => saveUser(user)}
                          >
                            <Save size={15} />
                            Apply
                          </button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}
          {["Document Rules", "Inventory Settings", "System Config"].includes(
            tab,
          ) && <ConfigPanel tab={tab} request={request} />}
        </>
      )}
    </>
  );
}

function Toggle({
  value,
  onChange,
  disabled,
}: {
  value: boolean;
  onChange?: () => void;
  disabled?: boolean;
}) {
  return (
    <button
      className={`toggle ${value ? "on" : ""}`}
      disabled={disabled}
      onClick={onChange}
    >
      <i />
    </button>
  );
}
function ConfigPanel({
  tab,
  request,
}: {
  tab: string;
  request: <T,>(path: string, init?: RequestInit) => Promise<T>;
}) {
  type InventoryOverview = {
    counts: {
      available: number;
      reserved: number;
      assigned: number;
      activated: number;
    };
    lowStockThreshold: number;
    lowStock: boolean;
  };
  const [inventory, setInventory] = useState<InventoryOverview | null>(null);
  const [systemConfig, setSystemConfig] = useState<Record<string, string>>({});
  const [error, setError] = useState("");
  const [topupMobile, setTopupMobile] = useState("");
  const [topupResult, setTopupResult] = useState<null | { found: boolean; subscriber?: { firstName: string; surname: string; currentPlan?: { name: string }; expiresAt?: string }; topUpAvailable?: boolean }>(null);
  const [busy, setBusy] = useState("");
  const [sweepResult, setSweepResult] = useState("");
  useEffect(() => {
    if (tab === "Inventory Settings") {
      setError("");
      request<InventoryOverview>("/operations/inventory")
        .then(setInventory)
        .catch((e) =>
          setError(e instanceof Error ? e.message : "Inventory unavailable"),
        );
    } else if (tab === "System Config") {
      setError("");
      request<Integration[]>("/admin/integrations")
        .then((items) => {
          const map: Record<string, string> = {};
          for (const item of items) map[item.name] = item.status;
          setSystemConfig(map);
        })
        .catch((e) =>
          setError(e instanceof Error ? e.message : "System config unavailable"),
        );
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab]);
  const rows: { label: string; value: string | number; ok?: boolean }[] =
    tab === "Document Rules"
      ? [
          { label: "Passport", value: "Required and verified for every purchase" },
          { label: "Travel ticket", value: "Required and verified before payment" },
          { label: "Supported formats", value: "JPEG, PNG, or PDF" },
          { label: "Maximum file size", value: "10 MB" },
          { label: "Review", value: "Operationally verified before approval" },
        ]
      : tab === "Inventory Settings"
        ? inventory
          ? [
              { label: "Available profiles", value: inventory.counts.available },
              { label: "Reserved", value: inventory.counts.reserved },
              { label: "Assigned", value: inventory.counts.assigned },
              { label: "Activated", value: inventory.counts.activated },
              {
                label: "Low-stock threshold",
                value: inventory.lowStockThreshold,
              },
              {
                label: "Inventory status",
                value: inventory.lowStock ? "LOW STOCK" : "Healthy",
                ok: !inventory.lowStock,
              },
            ]
          : []
        : [
            { label: "Default purchase country", value: "Nepal (NP)" },
            { label: "Default currency", value: "NPR" },
            { label: "Subscriber language", value: "English" },
            {
              label: "Connectivity provider",
              value: systemConfig["Transatel Connectivity"] ?? "—",
            },
            {
              label: "Payment gateway (Khalti)",
              value: systemConfig["Khalti Payment Gateway"] ?? "—",
            },
          ];
  return (
    <section className="config-panel">
      <div className="admin-section-head">
        <div>
          <h2>{tab}</h2>
          <p>Live platform defaults and enforced business rules.</p>
        </div>
      </div>
      {error ? <div className="catalog-error">{error}</div> : null}
      {rows.length ? (
        rows.map(({ label, value, ok }) => (
          <div className="config-row" key={label}>
            <span>
              <b>{label}</b>
              <small>{value}</small>
            </span>
            {ok !== undefined ? (
              ok ? (
                <CheckCircle2 size={18} />
              ) : (
                <span className="health-badge warning">ATTENTION</span>
              )
            ) : (
              <CheckCircle2 size={18} />
            )}
          </div>
        ))
      ) : (
        <p className="catalog-empty">Loading live data…</p>
      )}
      {tab === "System Config" && (
        <div className="config-ops">
          <div className="config-ops-block">
            <b>Look up a subscriber by MSISDN</b>
            <small>Detect an existing eSIM so future purchases are routed as top-ups.</small>
            <div className="config-ops-row">
              <input
                value={topupMobile}
                onChange={(e) => setTopupMobile(e.target.value)}
                placeholder="e.g. 9841234567"
              />
              <button className="button" disabled={Boolean(busy)} onClick={() => {
                setBusy("lookup");
                setError("");
                setTopupResult(null);
                request<{ found: boolean; subscriber?: { firstName: string; surname: string; currentPlan?: { name: string }; expiresAt?: string }; topUpAvailable?: boolean }>(`/operations/topup/lookup?mobile=${encodeURIComponent(topupMobile)}`)
                  .then(setTopupResult)
                  .catch((e) => setError(e instanceof Error ? e.message : "Lookup failed"))
                  .finally(() => setBusy(""));
              }}>
                {busy === "lookup" ? <LoaderCircle className="spin" size={15} /> : null}
                Look up
              </button>
            </div>
            {topupResult &&
              (topupResult.found && topupResult.subscriber ? (
                <p className="config-ops-note ok">
                  Found {topupResult.subscriber.firstName} {topupResult.subscriber.surname} —{" "}
                  {topupResult.subscriber.currentPlan?.name ?? "active subscriber"}
                  {topupResult.subscriber.expiresAt ? ` · valid until ${new Date(topupResult.subscriber.expiresAt).toLocaleDateString()}` : ""}. Future orders will be flagged TOP-UP.
                </p>
              ) : (
                <p className="config-ops-note warn">No active eSIM found for that MSISDN.</p>
              ))}
          </div>
          <div className="config-ops-block">
            <b>Payment lifecycle</b>
            <small>Expire abandoned payments that outlived their gateway window.</small>
            <button className="button" disabled={Boolean(busy)} onClick={() => {
              setBusy("sweep");
              setError("");
              request<{ expired: number }>("/operations/payments/expire-stale", { method: "POST", headers: { "x-idempotency-key": crypto.randomUUID() } })
                .then((r) => setSweepResult(`${r.expired} stale payment(s) expired`))
                .catch((e) => setError(e instanceof Error ? e.message : "Sweep failed"))
                .finally(() => setBusy(""));
            }}>
              {busy === "sweep" ? <LoaderCircle className="spin" size={15} /> : null}
              Expire stale payments
            </button>
            {sweepResult ? <p className="config-ops-note ok">{sweepResult}</p> : null}
          </div>
        </div>
      )}
    </section>
  );
}
