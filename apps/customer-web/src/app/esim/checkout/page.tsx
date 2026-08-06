import CheckoutClient from './checkout-client';
import AuthenticatedApiProvider from '../../authenticated-api-provider';
import './checkout.css';

export default async function Checkout({ searchParams }: { searchParams: Promise<{ plan?: string; order?: string; mobile?: string }> }) {
  const { plan, order, mobile } = await searchParams;
  return (
    <AuthenticatedApiProvider>
      <CheckoutClient planId={plan ?? ''} orderId={order ?? ''} mobile={mobile ?? ''} />
    </AuthenticatedApiProvider>
  );
}
