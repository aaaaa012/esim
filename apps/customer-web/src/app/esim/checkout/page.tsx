import CheckoutClient from './checkout-client';
import './checkout.css';

export default async function Checkout({ searchParams }: { searchParams: Promise<{ plan?: string; order?: string }> }) {
  const { plan, order } = await searchParams;
  return <CheckoutClient planId={plan ?? ''} orderId={order ?? ''} />;
}
