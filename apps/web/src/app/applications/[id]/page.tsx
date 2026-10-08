import React from 'react';
import { ApplicationWorkspace } from '@/components/applications/ApplicationWorkspace';
export default async function ApplicationDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  return <ApplicationWorkspace id={id} />;
}
