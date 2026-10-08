import { ReviewCenter } from '@/components/candidate/ReviewCenter';
export default async function Review({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  return <ReviewCenter applicationId={id} />;
}
