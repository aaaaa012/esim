import IntegrationEventsClient from './integration-events-client';
import { PageHeader } from '@/components/page-header';
export default function IntegrationEvents() {
  return (
    <>
      <PageHeader
        title="Events"
        description="Payment and connectivity callbacks, processing results and replay protection."
      />
      <IntegrationEventsClient />
    </>
  );
}