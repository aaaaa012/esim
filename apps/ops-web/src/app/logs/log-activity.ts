export type LogActivity = {
  group: "all" | "provider" | "incoming" | "orders" | "staff";
  identifier?: string;
  title: string;
};

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
  const provider =
    operation.startsWith("khalti") || endpoint.includes("epayment")
      ? "Khalti"
      : "Transatel";
  if (operation.includes("token") || endpoint.includes("/token"))
    return `${provider} Access Token Request`;
  if (operation.includes("initiat") || endpoint.includes("/initiate"))
    return "Khalti Payment Initiation";
  if (operation.includes("lookup") || endpoint.includes("/lookup"))
    return "Khalti Payment Lookup";
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
