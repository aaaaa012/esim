export type LogActivity = {
  group: "all" | "provider" | "incoming" | "orders" | "staff";
  identifier?: string;
  title: string;
};

export function providerLabel(entry: LogActivity): string {
  const identifier = entry.identifier ?? "";
  if (entry.group !== "provider") return identifier || "N/A";
  const operation = identifier.toLowerCase();
  const endpoint = entry.title.toLowerCase();
  if (operation.startsWith("fonepay") || endpoint.includes("thirdparty"))
    return "Fonepay";
  if (operation.startsWith("khalti") || endpoint.includes("epayment"))
    return "Khalti";
  if (
    operation.includes("transatel") ||
    operation.includes("subscriber") ||
    endpoint.includes("sim-management") ||
    endpoint.includes("/ocs/")
  )
    return "Transatel";
  return "External Provider";
}

export function activityLabel(entry: LogActivity): string {
  if (entry.group === "incoming") {
    const source = entry.identifier?.toLowerCase() ?? "";
    if (source.includes("khalti")) return "Khalti Payment Callback Received";
    if (source.includes("transatel"))
      return "Transatel Network Update Received";
    return "External Callback Received";
  }
  if (entry.group !== "provider") return entry.title;

  const operation = entry.identifier?.toLowerCase() ?? "";
  const endpoint = entry.title.toLowerCase();
  if (operation === "partner-api") return "Partner API Request";
  if (operation === "customer-topup-lookup") return "Customer eSIM Lookup";
  if (operation === "customer-topup-eligibility")
    return "Customer Top-up Eligibility";
  const provider = providerLabel(entry);
  if (operation.includes("token") || endpoint.includes("/token"))
    return `${provider} Access Token Request`;
  if (provider === "Fonepay") {
    if (operation.includes("authentication")) return "Fonepay Authentication";
    if (operation.includes("banks") || endpoint.includes("/banks/list"))
      return "Fonepay Bank List";
    if (operation.includes("generate-intent-qr"))
      return "Fonepay Payment Initiation";
    if (
      operation.includes("dynamicqrgetstatus") ||
      endpoint.includes("dynamicqrgetstatus")
    )
      return "Fonepay Payment Status Lookup";
  }
  if (operation.includes("initiat") || endpoint.includes("/initiate"))
    return `${provider} Payment Initiation`;
  if (operation.includes("lookup") || endpoint.includes("/lookup"))
    return `${provider} Payment Status Lookup`;
  if (operation.includes("provision")) return "Transatel eSIM Provisioning";
  if (operation.includes("usage")) return "Transatel Data-Usage Lookup";
  if (operation.includes("esim-details"))
    return "Transatel eSIM Details Lookup";
  if (operation.includes("subscriber-suspend"))
    return "Transatel eSIM Suspension";
  if (operation.includes("subscriber-reactivate"))
    return "Transatel eSIM Reactivation";
  if (operation.includes("subscriber-terminate"))
    return "Transatel eSIM Termination";
  if (operation.includes("catalog")) return "Transatel Plan Catalog Lookup";
  if (operation.includes("eligibility")) return "Transatel Eligibility Check";
  if (operation.includes("webhook")) return "Transatel Webhook Setup";
  return `${provider} Service Request`;
}
