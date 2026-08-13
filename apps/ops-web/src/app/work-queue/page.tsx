import QueueClient from './queue-client';
import { PageHeader } from '@/components/page-header';
export default function Queue() {
  return (
    <>
      <PageHeader
        title="Review queue"
        description="Orders grouped by what they need from your team."
      />
      <QueueClient />
    </>
  );
}