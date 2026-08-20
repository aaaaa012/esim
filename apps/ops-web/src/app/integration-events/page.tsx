import IntegrationEventsClient from "./integration-events-client";
import { PageHeader } from "@/components/page-header";
export default function IntegrationEvents() {
  return (
    <>
      <PageHeader
        title="Incoming updates"
        description="Messages from Khalti and the network provider, and how the system handled them."
      />
      <IntegrationEventsClient />
    </>
  );
}
