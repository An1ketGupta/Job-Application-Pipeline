import {
  chromium,
  type Browser,
  type BrowserContext,
  type Page,
  type Route,
} from 'playwright';
import {
  DestinationPolicy,
  InspectionError,
  type BrowserNetworkPolicy,
} from './policy.js';
import { forwardMutationOnce } from './mutation-transport.js';

export interface BrowserSession {
  browser: Browser;
  context: BrowserContext;
  page: Page;
  close(): Promise<void>;
  securityCheck(): Promise<void>;
  securitySnapshot(): {
    generation: number;
    violations: number;
    pending: number;
  };
}
export type ReadOnlyRequestGuard = (
  url: string,
  method: string,
  body: Buffer,
  contentType: string,
) => boolean | 'BLOCK_OPTIONAL';
export class BrowserSessionManager {
  private blockedNavigation: InspectionError | undefined;
  constructor(
    private readonly headless = true,
    private readonly policy: BrowserNetworkPolicy = new DestinationPolicy(),
    private readonly ignoreHTTPSErrors = false,
  ) {}
  get networkPolicy(): BrowserNetworkPolicy {
    return this.policy;
  }
  takeBlockedNavigation(): InspectionError | undefined {
    const error = this.blockedNavigation;
    this.blockedNavigation = undefined;
    return error;
  }
  async create(
    navigationGuard?: (url: string) => void,
    readOnlyRequestGuard?: ReadOnlyRequestGuard,
    frameNavigationGuard?: (url: string) => boolean,
  ): Promise<BrowserSession> {
    let browser: Browser;
    try {
      browser = await chromium.launch({ headless: this.headless });
    } catch (error) {
      throw new InspectionError('BROWSER_LAUNCH_FAILED', String(error));
    }
    try {
      const context = await browser.newContext({
        acceptDownloads: false,
        serviceWorkers: 'block',
        ignoreHTTPSErrors: this.ignoreHTTPSErrors,
      });
      context.setDefaultNavigationTimeout(15000);
      context.setDefaultTimeout(10000);
      let networkFailure: InspectionError | undefined;
      let generation = 0,
        violations = 0;
      const addressChecks = new Set<Promise<void>>();
      const pendingRoutes = new Set<Promise<void>>();
      const handleRoute = async (route: Route) => {
        const request = route.request();
        try {
          try {
            this.policy.validateRequest(request.url(), request.method());
          } catch (error) {
            if (
              !(error instanceof InspectionError) ||
              error.code !== 'MUTATING_REQUEST_BLOCKED' ||
              this.policy.forwardMutationsWithoutRetries
            )
              throw error;
            const decision = readOnlyRequestGuard?.(
              request.url(),
              request.method(),
              request.postDataBuffer() ?? Buffer.alloc(0),
              request.headers()['content-type'] ?? '',
            );
            if (
              decision === 'BLOCK_OPTIONAL' &&
              !request.isNavigationRequest()
            ) {
              await route.abort('blockedbyclient');
              return;
            }
            if (decision !== true) throw error;
            // Apply the same URL restrictions as ordinary reads after the
            // inspection-only guard has validated the complete POST payload.
            this.policy.validateRequest(request.url(), 'GET');
          }
          if (request.isNavigationRequest()) {
            this.policy.validateNavigation(request.url());
            if (
              request.frame() === page.mainFrame() ||
              !frameNavigationGuard?.(request.url())
            )
              navigationGuard?.(request.url());
          }
          await this.policy.validateAddress(request.url());
          if (
            this.policy.forwardMutationsWithoutRetries &&
            !['GET', 'HEAD'].includes(request.method())
          ) {
            // Pin an approved address and forward exactly once, with no transport retry.
            try {
              await forwardMutationOnce(
                route,
                this.policy,
                this.ignoreHTTPSErrors,
              );
            } catch (error) {
              throw error instanceof InspectionError
                ? error
                : new InspectionError(
                    'MUTATION_OUTCOME_UNKNOWN',
                    'Mutation transport failed without retry',
                  );
            }
          } else await route.continue();
        } catch (error) {
          // Record rejection before asynchronous audit/abort work can yield.
          generation++;
          violations++;
          try {
            await this.policy.auditRejectedRequest?.(
              request.url(),
              request.method(),
              request.postDataBuffer() ?? Buffer.alloc(0),
              error instanceof InspectionError
                ? error.code
                : 'UNSAFE_DESTINATION',
            );
          } catch {
            /* Failed audit persistence still refuses the request. */
          }
          networkFailure =
            error instanceof InspectionError
              ? error
              : new InspectionError(
                  'UNSAFE_DESTINATION',
                  'Network policy rejected request',
                );
          if (request.isNavigationRequest())
            this.blockedNavigation =
              error instanceof InspectionError
                ? error
                : new InspectionError('UNSAFE_DESTINATION', String(error));
          await route.abort('blockedbyclient');
        }
      };
      await context.route('**/*', (route) => {
        generation++;
        const pending = handleRoute(route);
        pendingRoutes.add(pending);
        void pending
          .finally(() => {
            pendingRoutes.delete(pending);
            generation++;
          })
          .catch(() => {});
        return pending;
      });
      await context.routeWebSocket('**/*', (socket) => {
        generation++;
        violations++;
        socket.close();
      });
      const page = await context.newPage();
      const navigationChanged = () => {
        generation++;
      };
      page.on('framenavigated', navigationChanged);
      page.on('frameattached', navigationChanged);
      page.on('framedetached', navigationChanged);
      page.on('response', (response) => {
        generation++;
        const check = (async () => {
          try {
            const address = await response.serverAddr();
            if (address)
              this.policy.validateConnectedAddress(
                response.url(),
                address.ipAddress,
              );
            if (response.request().isNavigationRequest()) {
              const location = response.headers()['location'];
              if (
                response.status() >= 300 &&
                response.status() < 400 &&
                location
              ) {
                const target = new URL(location, response.url()).href;
                this.policy.validateNavigation(target);
                if (
                  response.request().frame() === page.mainFrame() ||
                  !frameNavigationGuard?.(target)
                )
                  navigationGuard?.(target);
              }
              let count = 0;
              for (
                let request = response.request();
                request;
                request = request.redirectedFrom()!
              ) {
                this.policy.validateNavigation(request.url());
                if (
                  request.frame() === page.mainFrame() ||
                  !frameNavigationGuard?.(request.url())
                )
                  navigationGuard?.(request.url());
                if (++count > 20)
                  throw new InspectionError(
                    'TOO_MANY_REDIRECTS',
                    'Redirect limit exceeded',
                  );
              }
            }
          } catch (error) {
            generation++;
            violations++;
            networkFailure =
              error instanceof InspectionError
                ? error
                : new InspectionError(
                    'UNSAFE_DESTINATION',
                    'Connection validation failed',
                  );
          }
        })();
        addressChecks.add(check);
        void check
          .finally(() => {
            addressChecks.delete(check);
            generation++;
          })
          .catch(() => {});
      });
      // Popups are never part of the approved inspection destination.
      context.on('page', (opened) => {
        if (opened !== page) void opened.close();
      });
      return {
        browser,
        context,
        page,
        securityCheck: async () => {
          for (
            let round = 0;
            pendingRoutes.size || addressChecks.size;
            round++
          ) {
            if (round >= 32)
              throw new InspectionError(
                'SECURITY_INSPECTION_INCOMPLETE',
                'Network observation did not settle',
              );
            await Promise.allSettled([...pendingRoutes, ...addressChecks]);
          }
          if (networkFailure) throw networkFailure;
        },
        securitySnapshot: () => ({
          generation,
          violations,
          pending: pendingRoutes.size + addressChecks.size,
        }),
        close: async () => {
          try {
            await context.close();
          } finally {
            await browser.close();
          }
        },
      };
    } catch (error) {
      await browser.close();
      throw error;
    }
  }
}
