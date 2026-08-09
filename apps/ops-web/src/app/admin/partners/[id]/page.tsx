import PartnerWorkspace from './partner-workspace';

export default async function PartnerPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <PartnerWorkspace id={id} />;
}
