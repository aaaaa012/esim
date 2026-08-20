import IntegrationLogsClient from "./integration-logs-client";
import { PageHeader } from "@/components/page-header";

export default function IntegrationLogsPage() {
  return (
    <>
      <PageHeader
        title="System activity"
        description="A technical record of requests to our payment and network providers, used for troubleshooting with technical support."
      />
      <IntegrationLogsClient />
    </>
  );
}
