import HostedCheckoutClient from "./hosted-checkout-client";
import AuthenticatedApiProvider from "../../authenticated-api-provider";

export default async function PartnerCheckoutPage({
  params,
}: {
  params: Promise<{ token: string }>;
}) {
  const { token } = await params;
  return (
    <AuthenticatedApiProvider>
      <HostedCheckoutClient token={token} />
    </AuthenticatedApiProvider>
  );
}
