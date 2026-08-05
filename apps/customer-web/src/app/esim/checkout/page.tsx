import CheckoutClient from './checkout-client';
import './checkout.css';

export default async function Checkout({ searchParams }: { searchParams: Promise<{ plan?: string; order?: string; mobile?: string }> }) {
  const { plan, order, mobile } = await searchParams;
  return <CheckoutClient planId={plan ?? ''} orderId={order ?? ''} mobile={mobile ?? ''} />;
}
