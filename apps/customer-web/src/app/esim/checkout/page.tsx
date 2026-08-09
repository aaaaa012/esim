import CheckoutClient from './checkout-client';
import AuthenticatedApiProvider from '../../authenticated-api-provider';
import './checkout.css';

export default async function Checkout({ searchParams }: { searchParams: Promise<{ plan?: string; order?: string; mobile?: string; lookup?: string; esim?: string; country?: string }> }) {
  const { plan, order, mobile, lookup, esim, country } = await searchParams;
  return (
    <AuthenticatedApiProvider>
      <CheckoutClient planId={plan ?? ''} orderId={order ?? ''} mobile={mobile ?? ''} lookupToken={lookup ?? ''} targetEsimId={esim ?? ''} targetCountry={country ?? ''} />
    </AuthenticatedApiProvider>
  );
}
