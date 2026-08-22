export type LogActivity = {
  group: "all" | "provider" | "incoming" | "orders" | "staff";
  identifier?: string;
  title: string;
};

export function activityLabel(entry: LogActivity): string {
  if (entry.group === "incoming") {
    const source = entry.identifier?.toLowerCase() ?? "";
    if (source.includes("khalti")) return "Khalti payment callback received";
    if (source.includes("transatel"))
      return "Transatel network update received";
    return "External callback received";
  }
  if (entry.group !== "provider") return entry.title;

  const operation = entry.title.toLowerCase();
  const provider = entry.identifier?.toLowerCase() ?? "";
  if (operation.includes("token"))
    return `${provider.includes("khalti") ? "Khalti" : "Transatel"} access token request`;
  if (operation.includes("initiat")) return "Khalti payment initiation";
  if (operation.includes("lookup") || operation.includes("diagnostic"))
    return "Khalti payment lookup";
  if (operation.includes("provision")) return "Transatel eSIM provisioning";
  if (operation.includes("usage")) return "Transatel data-usage lookup";
  if (operation.includes("esim-details"))
    return "Transatel eSIM details lookup";
  if (operation.includes("subscriber-suspend"))
    return "Transatel eSIM suspension";
  if (operation.includes("subscriber-terminate"))
    return "Transatel eSIM termination";
  if (operation.includes("catalog")) return "Transatel plan catalog lookup";
  if (operation.includes("eligibility"))
    return "Transatel eligibility check";
  if (operation.includes("webhook")) return "Transatel webhook setup";
  return `${entry.identifier ?? "External provider"} service request`;
}
