"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { ArrowLeft, UserRound } from "lucide-react";
import { useAuthenticatedFetch } from "../../authenticated-api-provider";
import { PageHeader } from "@/components/page-header";
import { Panel } from "@/components/panel";
import { InfoRow } from "@/components/info-row";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/spinner";
import ErrorDialog from "@/components/error-dialog";
import { humane } from "@/components/status-badge";

const API = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:4000/api/v1";

type Identity = {
  id: string;
  email: string;
  status: string;
  accountType: string;
  mustChangePassword: boolean;
  createdAt: string;
  updatedAt: string;
  customer?: {
    id: string;
    customerCode: string;
    email: string;
    status: string;
  } | null;
};

export default function UserIdentityClient({ id }: { id: string }) {
  const authFetch = useAuthenticatedFetch();
  const [identity, setIdentity] = useState<Identity | null>(null);
  const [error, setError] = useState("");
  useEffect(() => {
    void authFetch(`${API}/operations/users/${id}/identity`, { headers: {} })
      .then(async (response) => {
        const value = await response.json();
        if (!response.ok)
          throw new Error(
            value.error?.message ?? "Account could not be loaded",
          );
        setIdentity(value.data);
      })
      .catch((cause) =>
        setError(cause instanceof Error ? cause.message : "Load failed"),
      );
  }, [authFetch, id]);

  return (
    <>
      <PageHeader
        title={identity?.email ?? "Login account"}
        description="Read-only authentication identity"
        badge={
          <span className="inline-flex items-center gap-2 text-sm">
            <UserRound className="size-4" />
            {identity ? humane(identity.status) : "Loading"}
          </span>
        }
        actions={
          identity?.customer ? (
            <Button asChild variant="ghost" size="sm">
              <Link href={`/customers/${identity.customer.id}`}>
                <ArrowLeft className="size-4" /> Customer
              </Link>
            </Button>
          ) : null
        }
      />
      <ErrorDialog error={error} onClose={() => setError("")} />
      {!identity && !error ? (
        <div className="flex h-40 items-center justify-center">
          <Spinner />
        </div>
      ) : null}
      {identity ? (
        <Panel
          title="Account identity"
          description="Credentials and provider tokens are never displayed."
        >
          <dl className="grid gap-4 sm:grid-cols-2">
            <InfoRow label="Email" value={identity.email} />
            <InfoRow
              label="Account type"
              value={humane(identity.accountType)}
            />
            <InfoRow label="Status" value={humane(identity.status)} />
            <InfoRow
              label="Password change required"
              value={identity.mustChangePassword ? "Yes" : "No"}
            />
            <InfoRow
              label="Created"
              value={new Date(identity.createdAt).toLocaleString()}
            />
            <InfoRow
              label="Updated"
              value={new Date(identity.updatedAt).toLocaleString()}
            />
          </dl>
        </Panel>
      ) : null}
    </>
  );
}
