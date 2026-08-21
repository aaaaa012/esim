import OrderReview from "./review";
export default async function Page({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  return <OrderReview id={(await params).id} />;
}
