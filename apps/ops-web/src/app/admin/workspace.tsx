"use client";
import { useAuthenticatedFetch } from "../authenticated-api-provider";
import { useEffect, useState } from "react";
import {
  CheckCircle2,
  FlaskConical,
  LoaderCircle,
  Pencil,
  RefreshCcw,
  Save,
  Settings2,
  ShieldCheck,
  Upload,
  UsersRound,
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
const tabs = [
  "Plans",
  "Pricing",
  "Integrations",
  "Document Rules",
  "Inventory Settings",
  "Users",
  "System Config",
];
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
  const importPlanCsv = async () => {
    if (!planCsvFile) {
      setPlanCsvResult("Choose a CSV file first");
      return;
    }
    setPlanCsvBusy(true);
    setPlanCsvResult("");
    setPlanCsvErrors([]);
    try {
      const csv = await planCsvFile.text();
      const result = await request<{
        imported: number;
        updated: number;
        skipped: number;
        errors: string[];
      }>("/admin/plans/import-csv", {
        method: "POST",
        body: JSON.stringify({ csv }),
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
      await request("/admin/staff-invitations", {
        method: "POST",
        body: JSON.stringify({ email: inviteEmail, accountType: inviteType }),
      });
      setInviteEmail("");
      await load();
      setNotice("Staff invitation sent");
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
                    accept=".csv,text/csv"
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
                    <Toggle value={item.enabled} disabled />
                  </div>
                  <code>{item.secretValue}</code>
                  <small>
                    Last checked: {new Date(item.checkedAt).toLocaleString()}
                  </small>
                  <div className="integration-actions">
                    <button
                      onClick={() =>
                        setNotice(
                          `${item.name}: secrets are managed in the environment/secret manager and never returned to this UI.`,
                        )
                      }
                    >
                      <Pencil size={15} />
                      Configure
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
                      </>
                    )}
                  </div>
                </article>
              ))}
            </div>
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
          ) && <ConfigPanel tab={tab} />}
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
function ConfigPanel({ tab }: { tab: string }) {
  const content =
    tab === "Document Rules"
      ? [
          ["Passport required", "Required for every purchase"],
          ["Travel ticket required", "Required before payment"],
          ["Visa requirement", "Configuration driven by destination"],
        ]
      : tab === "Inventory Settings"
        ? [
            ["Low-stock threshold", "10 profiles"],
            ["Reservation timing", "After approval, before provisioning"],
            ["Assigned inventory", "Never returned to available"],
          ]
        : [
            ["Default purchase country", "Nepal (NP)"],
            ["Default currency", "NPR"],
            ["Subscriber language", "English"],
            ["Connectivity provider", "Transatel"],
          ];
  return (
    <section className="config-panel">
      <div className="admin-section-head">
        <div>
          <h2>{tab}</h2>
          <p>Safe platform defaults defined by the approved business rules.</p>
        </div>
      </div>
      {content.map(([label, value]) => (
        <div className="config-row" key={label}>
          <span>
            <b>{label}</b>
            <small>{value}</small>
          </span>
          <CheckCircle2 size={18} />
        </div>
      ))}
    </section>
  );
}
