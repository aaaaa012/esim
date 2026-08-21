import LogsClient from "./logs-client";
import { PageHeader } from "@/components/page-header";

export default function LogsPage() {
  return (
    <>
      <PageHeader
        title="Logs"
        description="A searchable record of provider calls, incoming updates, eSIM activation activity, and audited staff changes. Downloaded records contain sanitized operational data."
      />
      <LogsClient />
    </>
  );
}
