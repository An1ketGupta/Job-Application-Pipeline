'use client';
import React, { useCallback } from 'react';
import Link from 'next/link';
import { fetchApplication } from '@/lib/api';
import type { ApplicationDetail } from '@/lib/types';
import { useAuth } from '@/lib/auth-context';
import { useWorkspaceQuery } from '@/lib/use-workspace-query';
import { ApplicationPreparationActions } from '../candidate/ApplicationPreparationActions';
import { ApplicationExecutionActions } from '../candidate/ApplicationExecutionActions';
import { GoogleFormWorkflow } from './GoogleFormWorkflow';
import { EmailApplicationActions } from '../email/EmailApplicationActions';
import {
  ApplicationDetailsView,
  WorkspaceError,
  WorkspaceLoading,
  LiveStatus,
  button,
} from './WorkspaceUI';
const active = (value: { application: ApplicationDetail }) =>
  value.application.active;
export function ApplicationWorkspace({ id }: { id: string }) {
  const { token, user, isLoading: authLoading } = useAuth();
  const read = useCallback(
    (signal: AbortSignal) => fetchApplication(id, token!, signal),
    [id, token],
  );
  const query = useWorkspaceQuery(
    read,
    active,
    !!token && !authLoading,
    `${token}|${id}`,
  );
  return (
    <article className="space-y-5">
      <div className="flex items-center justify-between gap-3">
        <Link
          className="text-sm font-medium text-indigo-600"
          href="/applications"
        >
          ← Back to Applications
        </Link>
        <button
          type="button"
          className={button}
          disabled={query.busy || !token || authLoading}
          onClick={query.refresh}
        >
          Refresh
        </button>
      </div>
      {authLoading ? (
        <WorkspaceLoading />
      ) : !token ? (
        <WorkspaceError
          message="Log in to view this application."
          refresh={query.refresh}
        />
      ) : (
        <>
          <LiveStatus
            busy={query.busy}
            stopped={query.stopped}
            active={query.data?.application.active ?? false}
          />
          {query.error && (
            <WorkspaceError message={query.error} refresh={query.refresh} />
          )}
          {query.data ? (
            <>
              <EmailApplicationActions
                application={query.data.application}
                token={token}
                refresh={query.refresh}
              />
              <ApplicationPreparationActions
                key={`preparation-${id}-${user?.id}`}
                application={query.data.application}
                token={token}
                refresh={query.refresh}
              />
              <ApplicationDetailsView application={query.data.application} />
              {(query.data.application.googleForm ||
                query.data.application.plan?.platform === 'GOOGLE_FORM') && (
                <GoogleFormWorkflow
                  key={`forms-${id}-${user?.id}`}
                  applicationId={id}
                  token={token}
                  refreshApplication={query.refresh}
                />
              )}
              <ApplicationExecutionActions
                key={`execution-${id}-${user?.id}`}
                application={query.data.application}
                token={token}
                refresh={query.refresh}
              />
            </>
          ) : (
            !query.error && <WorkspaceLoading />
          )}
        </>
      )}
    </article>
  );
}
