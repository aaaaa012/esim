import NotificationsClient from "./notifications-client";
import { PageHeader } from "@/components/page-header";
export default function NotificationsPage() {
  return (
    <>
      <PageHeader
        title="Notifications"
        description="Delivery attempts, channel health, failures and controlled retries."
      />
      <NotificationsClient />
    </>
  );
}
