import AuditClient from './audit-client';
import { PageHeader } from '@/components/page-header';
export default function Audit() {
  return (
    <>
      <PageHeader
        title="Audit log"
        description="Immutable operational events ordered newest first."
      />
      <AuditClient />
    </>
  );
}