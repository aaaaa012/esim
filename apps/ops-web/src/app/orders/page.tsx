import OrdersClient from './orders-client';
import { PageHeader } from '@/components/page-header';
export default function OrdersPage() {
  return (
    <>
      <PageHeader
        title="Orders"
        description="Search and manage customer orders end to end."
      />
      <OrdersClient />
    </>
  );
}