import LogsClient from "./logs-client";
import { PageHeader } from "@/components/page-header";

export default function LogsPage() {
  return (
    <>
      <PageHeader
        title="Logs"
        description="A record of everything the system received and sent — payment and network calls, incoming updates, eSIM activations and staff changes. Use the filter to narrow the list, and download any record as a text file."
      />
      <LogsClient />
    </>
  );
}