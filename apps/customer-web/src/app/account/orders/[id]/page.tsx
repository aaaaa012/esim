import EsimDetails from "../../esims/[id]/esim-details";
import "../../esims/esims.css";
import "../../esims/[id]/details.css";
export default async function OrderPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  return <EsimDetails id={(await params).id} />;
}
