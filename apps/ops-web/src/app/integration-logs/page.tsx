import IntegrationLogsClient from "./integration-logs-client";
import { PageHeader } from "@/components/page-header";

export default function IntegrationLogsPage() {
  return (
    <>
      <PageHeader
        title="Provider logs"
        description="Outbound network provider requests and outcomes — request, response and error detail."
      />
      <IntegrationLogsClient />
    </>
  );
}