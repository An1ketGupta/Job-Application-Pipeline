import { randomUUID } from 'node:crypto';
import {
  ApplicationPlanSchema,
  ApplicationSchemaSchema,
  type ApplicationPlan,
  type ApplicationSchema,
  matchesAtsTarget,
  atsUrlIdentity,
} from '@careerlift/domain';
import { extractPage, classifyPage } from './extract.js';
import { detectPlatform } from './platform.js';
import { InspectionError, validateRedirectChain } from './policy.js';
import { BrowserSessionManager } from './session.js';

export interface InspectionOutcome {
  status: 'COMPLETED' | 'HUMAN_REQUIRED' | 'FAILED';
  schema?: ApplicationSchema;
  errorCode?: string;
  message?: string;
}

export class ApplicationInspector {
  constructor(
    private readonly sessions = new BrowserSessionManager(),
    private readonly fixtureTargets: ReadonlyMap<string, string> = new Map(),
  ) {}
  async inspect(
    planInput: ApplicationPlan,
    applicationPlanId: string,
    inspectionId: string = randomUUID(),
  ): Promise<InspectionOutcome> {
    if (this.sessions.networkPolicy.forwardMutationsWithoutRetries)
      return { status: 'FAILED', errorCode: 'READ_ONLY_POLICY_REQUIRED' };
    const parsed = ApplicationPlanSchema.safeParse(planInput);
    if (!parsed.success) return { status: 'FAILED', errorCode: 'INVALID_PLAN' };
    const plan = parsed.data;
    const target = plan.destination.target;
    const sourceUrl = plan.destination.url;
    if (!sourceUrl)
      return { status: 'FAILED', errorCode: 'NO_BROWSER_DESTINATION' };
    if (
      target?.fixtureSourceUrl &&
      this.fixtureTargets.get(sourceUrl) !== target.fixtureSourceUrl
    )
      return { status: 'FAILED', errorCode: 'UNTRUSTED_FIXTURE_TARGET' };
    try {
      this.sessions.networkPolicy.validateNavigation(sourceUrl);
      await this.sessions.networkPolicy.validateAddress(sourceUrl);
    } catch {
      return {
        status: target ? 'HUMAN_REQUIRED' : 'FAILED',
        errorCode: 'UNSAFE_DESTINATION',
      };
    }
    if (
      plan.applicationType === 'EMAIL' ||
      plan.applicationType === 'UNKNOWN' ||
      plan.applicationType === 'HUMAN_REQUIRED'
    )
      return { status: 'FAILED', errorCode: 'UNSUPPORTED_PLAN_TYPE' };
    const started = Date.now();
    let session;
    let unsafeRedirect: InspectionError | undefined;
    let unsafeConnection: InspectionError | undefined;
    const addressChecks: Promise<void>[] = [];
    try {
      session = await this.sessions.create(
        target
          ? (url) => {
              const approved = target.fixtureSourceUrl
                ? url === sourceUrl
                : matchesAtsTarget(target, url);
              if (!approved)
                throw new InspectionError(
                  'UNEXPECTED_NAVIGATION',
                  'The ATS destination changed and requires human review',
                );
            }
          : undefined,
      );
      const page = session.page;
      page.on('response', (redirectResponse) => {
        addressChecks.push(
          redirectResponse
            .serverAddr()
            .then((connected) => {
              if (connected)
                this.sessions.networkPolicy.validateConnectedAddress(
                  redirectResponse.url(),
                  connected.ipAddress,
                );
            })
            .catch((error: unknown) => {
              unsafeConnection =
                error instanceof InspectionError
                  ? error
                  : new InspectionError('UNSAFE_DESTINATION', String(error));
            }),
        );
        if (!redirectResponse.request().isNavigationRequest()) return;
        if (redirectResponse.status() < 300 || redirectResponse.status() >= 400)
          return;
        const location = redirectResponse.headers()['location'];
        if (!location) return;
        try {
          this.sessions.networkPolicy.validateNavigation(
            new URL(location, redirectResponse.url()).href,
          );
          if (target) {
            const redirect = new URL(location, redirectResponse.url()).href;
            if (
              target.fixtureSourceUrl
                ? redirect !== sourceUrl
                : !matchesAtsTarget(target, redirect)
            )
              throw new InspectionError(
                'UNEXPECTED_NAVIGATION',
                'The ATS destination changed and requires human review',
              );
          }
        } catch (error) {
          unsafeRedirect =
            error instanceof InspectionError
              ? error
              : new InspectionError(
                  'UNSAFE_DESTINATION',
                  'Redirect target violates destination policy',
                );
        }
      });
      const response = await page.goto(sourceUrl, {
        waitUntil: 'domcontentloaded',
        timeout: 15000,
      });
      if (unsafeRedirect) throw unsafeRedirect;
      const blocked = this.sessions.takeBlockedNavigation();
      if (blocked) throw blocked;
      if (!response)
        throw new InspectionError(
          'NAVIGATION_FAILED',
          'No navigation response',
        );
      if (target && [401, 403].includes(response.status()))
        throw new InspectionError(
          'AUTHENTICATION_OR_SECURITY_CHALLENGE',
          'The platform requires authentication or security review',
        );
      if (target && [404, 410].includes(response.status()))
        throw new InspectionError(
          'APPLICATION_CLOSED',
          'The application page is closed or unavailable',
        );
      if (response.status() >= 400)
        throw new InspectionError(
          'HTTP_ERROR',
          `Destination returned HTTP ${response.status()}`,
        );
      const connected = await response.serverAddr();
      if (connected)
        this.sessions.networkPolicy.validateConnectedAddress(
          response.url(),
          connected.ipAddress,
        );
      const chain: string[] = [];
      let request = response.request();
      while (request) {
        chain.unshift(request.url());
        request = request.redirectedFrom()!;
      }
      validateRedirectChain(chain, this.sessions.networkPolicy);
      const finalUrl = page.url();
      this.sessions.networkPolicy.validateNavigation(finalUrl);
      const raw = await Promise.race([
        extractPage(page),
        new Promise<never>((_, reject) =>
          setTimeout(
            () =>
              reject(
                new InspectionError(
                  'INSPECTION_TIMEOUT',
                  'Page inspection timed out',
                ),
              ),
            10000,
          ),
        ),
      ]);
      await Promise.all(addressChecks);
      if (unsafeConnection) throw unsafeConnection;
      await session.securityCheck();
      if (!raw.title && !raw.visibleText && raw.fields.length === 0)
        throw new InspectionError(
          'EMPTY_PAGE',
          'Page has no inspectable content',
        );
      const detected = detectPlatform(
        finalUrl,
        raw.signature,
        raw.forms.length > 0 || raw.fields.length > 0,
      );
      if (target?.fixtureSourceUrl && finalUrl === sourceUrl) {
        const independent = atsUrlIdentity(this.fixtureTargets.get(finalUrl)!);
        if (independent) {
          detected.platform = independent.platform;
          detected.confidence = 1;
        }
      }
      const classified = classifyPage(raw);
      if (target) {
        const approved = (url: string) =>
          target.fixtureSourceUrl
            ? url === sourceUrl
            : matchesAtsTarget(target, url);
        if ([...chain, finalUrl].some((url) => !approved(url)))
          classified.humanReview.reasons.push('UNEXPECTED_NAVIGATION');
        if (detected.platform !== target.platform)
          classified.humanReview.reasons.push('PLATFORM_MISMATCH');
        // Descriptive multi-step support is not an inspected execution flow.
        if (
          !raw.executionFlow &&
          raw.buttons.some((label) => /^(next|continue)\b/i.test(label))
        )
          classified.humanReview.reasons.push('UNSUPPORTED_INTERACTION');
        classified.humanReview.required =
          classified.humanReview.reasons.length > 0;
      }
      const expected =
        plan.applicationType === 'GOOGLE_FORM'
          ? 'GOOGLE_FORM'
          : plan.applicationType === 'GOOGLE_DOC'
            ? 'GOOGLE_DOC'
            : plan.applicationType === 'LINKEDIN'
              ? 'LINKEDIN'
              : plan.provider &&
                  plan.provider !== 'OTHER' &&
                  plan.provider !== 'UNKNOWN'
                ? plan.provider
                : undefined;
      const schema = ApplicationSchemaSchema.parse({
        inspectionId,
        applicationPlanId,
        sourceUrl,
        finalUrl,
        redirectChain: chain,
        finalHostname: new URL(finalUrl).hostname,
        plannedApplicationType: plan.applicationType,
        platform: detected.platform,
        platformDiscrepancy: Boolean(
          expected && expected !== detected.platform,
        ),
        title: raw.title,
        ...classified,
        forms: raw.forms,
        ...(raw.executionFlow ? { executionFlow: raw.executionFlow } : {}),
        confidence: detected.confidence,
        inspectionMetadata: {
          inspectedAt: new Date().toISOString(),
          durationMs: Date.now() - started,
          visibleTextExcerpt: raw.visibleText,
          fieldCount: classified.fields.length,
        },
      });
      return {
        status: schema.humanReview.required ? 'HUMAN_REQUIRED' : 'COMPLETED',
        schema,
      };
    } catch (error) {
      const blocked = this.sessions.takeBlockedNavigation();
      const known =
        unsafeRedirect ??
        unsafeConnection ??
        blocked ??
        (error instanceof InspectionError ? error : undefined);
      const code =
        known?.code ??
        (String(error).includes('Timeout')
          ? 'NAVIGATION_TIMEOUT'
          : String(error).includes('net::ERR_NAME_NOT_RESOLVED')
            ? 'DNS_FAILURE'
            : /ERR_CONNECTION|ERR_INTERNET_DISCONNECTED|ERR_ADDRESS_UNREACHABLE/.test(
                  String(error),
                )
              ? 'CONNECTION_FAILURE'
              : 'INSPECTION_FAILED');
      return {
        status:
          (target &&
            [
              'UNSAFE_DESTINATION',
              'AUTHENTICATION_OR_SECURITY_CHALLENGE',
            ].includes(code)) ||
          [
            'UNEXPECTED_NAVIGATION',
            'MUTATING_REQUEST_BLOCKED',
            'SECURITY_INSPECTION_INCOMPLETE',
          ].includes(code)
            ? 'HUMAN_REQUIRED'
            : 'FAILED',
        errorCode: code,
        ...(known?.message ? { message: known.message } : {}),
      };
    } finally {
      try {
        await session?.close();
      } catch {
        /* preserve the structured inspection outcome */
      }
    }
  }
}
