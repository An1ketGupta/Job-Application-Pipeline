'use client';
import { useEffect, useState } from 'react';
import { ApiError } from './api';
import { startWorkspacePolling } from './workspace-polling';

export function useWorkspaceQuery<T>(
  read: (signal: AbortSignal) => Promise<T>,
  active: (value: T) => boolean,
  enabled: boolean,
  identity: string,
) {
  const [result, setResult] = useState<{ identity: string; data: T } | null>(
    null,
  );
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [stopped, setStopped] = useState<string | null>(null);
  const [refreshKey, setRefreshKey] = useState(0);
  useEffect(() => {
    setError(null);
    setStopped(null);
    if (!enabled) {
      setBusy(false);
      setResult(null);
      return;
    }
    return startWorkspacePolling({
      read,
      active,
      onData: (data) => setResult({ identity, data }),
      onError: (error) =>
        setError(
          error instanceof ApiError
            ? error.message
            : 'Unable to load applications. Please refresh.',
        ),
      onBusy: setBusy,
      onStopped: setStopped,
      visible: () => document.visibilityState === 'visible',
    });
  }, [read, active, enabled, identity, refreshKey]);
  return {
    data: enabled && result?.identity === identity ? result.data : null,
    error,
    busy,
    stopped,
    refresh: () => {
      setRefreshKey((value) => value + 1);
    },
  };
}
