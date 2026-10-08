// Completion-based scheduling prevents overlapping reads. Every session is bounded.
export function startWorkspacePolling<T>(options: {
  read: (signal: AbortSignal) => Promise<T>;
  onData: (value: T) => void;
  onError: (error: unknown) => void;
  onBusy: (busy: boolean) => void;
  onStopped: (reason: 'terminal' | 'limit' | 'error') => void;
  active: (value: T) => boolean;
  visible?: () => boolean;
  intervalMs?: number;
  maxReads?: number;
  maxDurationMs?: number;
  requestTimeoutMs?: number;
}) {
  let disposed = false,
    reads = 0;
  const controller = new AbortController();
  const started = Date.now();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let requestTimer: ReturnType<typeof setTimeout> | undefined;
  const stop = (reason: 'terminal' | 'limit' | 'error') => {
    if (disposed) return;
    disposed = true;
    controller.abort();
    if (timer) clearTimeout(timer);
    if (requestTimer) clearTimeout(requestTimer);
    clearTimeout(deadline);
    options.onBusy(false);
    options.onStopped(reason);
  };
  const deadline = setTimeout(
    () => stop('limit'),
    options.maxDurationMs ?? 300000,
  );
  const interval = options.intervalMs ?? 5000;
  const expired = () =>
    reads >= (options.maxReads ?? 60) ||
    Date.now() - started >= (options.maxDurationMs ?? 300000);
  const run = async () => {
    if (disposed) return;
    if (expired()) {
      stop('limit');
      return;
    }
    if (reads > 0 && options.visible && !options.visible()) {
      timer = setTimeout(run, interval);
      return;
    }
    reads++;
    options.onBusy(true);
    requestTimer = setTimeout(() => {
      options.onError(new Error('Application read timed out'));
      stop('error');
    }, options.requestTimeoutMs ?? 20000);
    try {
      const value = await options.read(controller.signal);
      if (requestTimer) clearTimeout(requestTimer);
      if (disposed) return;
      options.onData(value);
      if (!options.active(value)) {
        stop('terminal');
        return;
      }
      if (expired()) {
        stop('limit');
        return;
      }
      timer = setTimeout(run, interval);
    } catch (error) {
      if (!disposed) {
        options.onError(error);
        stop('error');
      }
    } finally {
      if (!disposed) options.onBusy(false);
      if (requestTimer) clearTimeout(requestTimer);
    }
  };
  void run();
  return () => {
    disposed = true;
    controller.abort();
    if (timer) clearTimeout(timer);
    if (requestTimer) clearTimeout(requestTimer);
    clearTimeout(deadline);
  };
}
