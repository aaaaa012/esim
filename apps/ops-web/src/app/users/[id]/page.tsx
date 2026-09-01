import UserIdentityClient from "./user-identity-client";

export default async function UserIdentityPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  return <UserIdentityClient id={(await params).id} />;
}
