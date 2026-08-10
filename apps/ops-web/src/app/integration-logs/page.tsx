import IntegrationLogsClient from "./integration-logs-client";
import { PageHeader } from "@/components/page-header";

export default function IntegrationLogsPage() {
  return (
    <>
      <PageHeader
        title="Integration logs"
        description="Outbound provider requests and outcomes — request, response and error detail."
      />
      <IntegrationLogsClient />
    </>
  );
}