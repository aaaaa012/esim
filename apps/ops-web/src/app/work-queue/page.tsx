import OrdersClient from '../orders/orders-client';
import { PageHeader } from '@/components/page-header';
export default function Queue() {
  return (
    <>
      <PageHeader
        title="Work queue"
        description="Orders that require an operations decision."
      />
      <OrdersClient queueOnly />
    </>
  );
}