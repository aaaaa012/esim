import CustomerProfile from "./customer-profile-client";

export default async function Page({
  params,
}: {
  params: Promise<{ ownerId: string }>;
}) {
  return <CustomerProfile ownerId={decodeURIComponent((await params).ownerId)} />;
}