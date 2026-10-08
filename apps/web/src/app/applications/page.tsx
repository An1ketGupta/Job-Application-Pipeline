import React, { Suspense } from 'react';
import { ApplicationsDashboard } from '@/components/applications/ApplicationsDashboard';
import { WorkspaceLoading } from '@/components/applications/WorkspaceUI';
export default function ApplicationsPage() {
  return (
    <Suspense fallback={<WorkspaceLoading />}>
      <ApplicationsDashboard />
    </Suspense>
  );
}
