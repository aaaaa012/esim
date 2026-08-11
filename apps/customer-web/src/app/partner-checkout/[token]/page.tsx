import HostedCheckoutClient from "./hosted-checkout-client";

export default async function PartnerCheckoutPage({
  params,
}: {
  params: Promise<{ token: string }>;
}) {
  const { token } = await params;
  return <HostedCheckoutClient token={token} />;
}