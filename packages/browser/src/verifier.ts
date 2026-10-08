import { createHash } from 'node:crypto';
import {
  evidenceIdentity,
  type SubmissionVerifier,
  type VerificationContext,
  type VerificationEvidence,
  type VerificationResult,
} from '@careerlift/domain';
import { BrowserSessionManager, type BrowserSession } from './session.js';
import {
  DestinationPolicy,
  InspectionError,
  type BrowserNetworkPolicy,
} from './policy.js';
import { inspectSecurityControls } from './security-controls.js';
import { suspendPageScripts } from './trusted-dom.js';

const digest = (value: string) =>
  createHash('sha256').update(value).digest('hex');
export function ledgerEvidence(
  context: VerificationContext,
): VerificationEvidence[] {
  if (!context.responseStatus || !context.responseReceivedAt) return [];
  return [
    {
      ...evidenceIdentity(context),
      source: 'MUTATION_LEDGER',
      strength: 'WEAK',
      type:
        context.responseStatus >= 300 && context.responseStatus < 400
          ? 'HTTP_REDIRECT'
          : context.responseStatus >= 200 && context.responseStatus < 300
            ? 'HTTP_SUCCESS'
            : 'HTTP_RESPONSE',
      capturedAt: context.responseReceivedAt,
      httpStatus: context.responseStatus,
      ...(context.responseFingerprint
        ? { responseFingerprint: context.responseFingerprint }
        : {}),
      outcome: 'UNKNOWN',
    },
  ];
}
export class GenericSubmissionVerifier implements SubmissionVerifier {
  supports() {
    return true;
  }
  async verify(context: VerificationContext): Promise<VerificationResult> {
    return {
      evidence: ledgerEvidence(context),
      reason: 'NO_DETERMINISTIC_PLATFORM_VERIFIER',
    };
  }
}

// Ashby's typed GraphQL outcome comes from the original pinned POST response,
// bound to the persisted final mutation. A generic HTTP 200 is still weak.
export class AshbySubmissionVerifier implements SubmissionVerifier {
  supports(context: VerificationContext) {
    return context.platform === 'ASHBY' && !!context.providerOutcome;
  }
  async verify(
    context: VerificationContext,
    signal: AbortSignal,
  ): Promise<VerificationResult> {
    signal.throwIfAborted();
    if (
      !this.supports(context) ||
      context.mutationOutcome !== 'FORWARDED' ||
      context.responseStatus !== 200 ||
      !context.responseFingerprint ||
      !context.responseReceivedAt
    )
      return {
        evidence: ledgerEvidence(context),
        reason: 'NO_BOUND_ASHBY_RESPONSE',
      };
    return {
      evidence: [
        {
          ...evidenceIdentity(context),
          type: 'HTTP_RESPONSE',
          source: 'PROVIDER_RESPONSE',
          strength: 'STRONG',
          capturedAt: context.responseReceivedAt,
          httpStatus: 200,
          responseFingerprint: context.responseFingerprint,
          outcome: context.providerOutcome!,
        },
      ],
      reason: 'ASHBY_TYPED_SUBMISSION_RESPONSE',
    };
  }
}

// Only a trusted, explicitly configured local HTTPS fixture gets this adapter.
// No production ATS is claimed to support this private fixture receipt protocol.
class VerificationReadPolicy implements BrowserNetworkPolicy {
  constructor(
    private readonly target: string,
    private readonly base: BrowserNetworkPolicy,
  ) {}
  validateNavigation(url: string) {
    this.base.validateNavigation(url);
    if (url !== this.target)
      throw new InspectionError(
        'UNEXPECTED_NAVIGATION',
        'Unapproved verification target',
      );
  }
  validateRequest(url: string, method: string) {
    if (!['GET', 'HEAD'].includes(method))
      throw new InspectionError(
        'MUTATING_REQUEST_BLOCKED',
        'Verification is read only',
      );
    this.validateNavigation(url);
  }
  async validateAddress(url: string) {
    this.validateNavigation(url);
    await this.base.validateAddress(url);
  }
  validateConnectedAddress(url: string, address: string) {
    this.validateNavigation(url);
    this.base.validateConnectedAddress(url, address);
  }
}
type ReceiptNode = {
  backendNodeId?: number;
  nodeName: string;
  nodeValue: string;
  attributes?: string[];
  children?: ReceiptNode[];
  shadowRoots?: ReceiptNode[];
  shadowRootType?: string;
  contentDocument?: ReceiptNode;
};
const attributes = (node: ReceiptNode) => {
  const attrs = new Map<string, string>();
  for (let i = 0; i < (node.attributes?.length ?? 0); i += 2)
    attrs.set(node.attributes![i]!, node.attributes![i + 1]!);
  return attrs;
};
// Only browser-protocol nodes enter this bounded traversal. Frame documents and
// native shadow roots are separate CDP edges, not element children.
export function inspectReceiptTopology(root: ReceiptNode) {
  const pending = [root],
    receipts: ReceiptNode[] = [];
  const records: unknown[] = [];
  let count = 0,
    bytes = 0,
    complete = true;
  while (pending.length) {
    const node = pending.pop()!;
    if (
      ++count > 10000 ||
      (bytes +=
        node.nodeValue.length + (node.attributes?.join('').length ?? 0)) >
        128000
    )
      throw new InspectionError(
        'VERIFICATION_DOM_LIMIT',
        'Receipt topology limit exceeded',
      );
    records.push([
      node.backendNodeId,
      node.nodeName,
      node.nodeValue,
      node.attributes,
    ]);
    if (
      node.shadowRootType === 'closed' ||
      (['IFRAME', 'FRAME'].includes(node.nodeName) && !node.contentDocument)
    )
      complete = false;
    if (
      node.nodeName === 'SECTION' &&
      attributes(node).get('id') === 'careerlift-receipt'
    )
      receipts.push(node);
    pending.push(
      ...(node.children ?? []),
      ...(node.shadowRoots ?? []),
      ...(node.contentDocument ? [node.contentDocument] : []),
    );
  }
  return { receipts, complete, fingerprint: digest(JSON.stringify(records)) };
}
export class LocalFixtureSubmissionVerifier implements SubmissionVerifier {
  constructor(
    private readonly origin: string,
    private readonly sessions: (policy: BrowserNetworkPolicy) => {
      create(): Promise<BrowserSession>;
    } = (policy) => new BrowserSessionManager(true, policy),
  ) {
    const parsed = new URL(origin);
    if (
      parsed.protocol !== 'https:' ||
      !['127.0.0.1', 'localhost', '[::1]'].includes(parsed.hostname) ||
      parsed.origin !== origin
    )
      throw new Error('LOCAL_HTTPS_FIXTURE_REQUIRED');
  }
  supports(context: VerificationContext) {
    return (
      context.mode === 'TEST_FIXTURE' &&
      new URL(context.destination).origin === this.origin
    );
  }
  async verify(
    context: VerificationContext,
    signal: AbortSignal,
  ): Promise<VerificationResult> {
    if (!this.supports(context))
      throw new Error('UNSUPPORTED_VERIFICATION_CONTEXT');
    const evidence = ledgerEvidence(context);
    // Legacy fixtureReceipt is local execution metadata and is deliberately ignored.
    const uncertain = (
      reason: string,
      blocksPriorEvidence = true,
    ): VerificationResult => ({
      evidence: [
        ...evidence,
        {
          ...evidenceIdentity(context),
          type: 'EXTERNAL_LOOKUP',
          source: 'LOCAL_FIXTURE',
          strength: 'NONE',
          outcome: 'UNKNOWN',
          capturedAt: new Date().toISOString(),
          ...(blocksPriorEvidence ? { verificationIssue: reason } : {}),
        },
      ],
      reason,
    });
    const target = `${this.origin}/careerlift/status/${encodeURIComponent(context.mutationId)}`;
    const policy = new VerificationReadPolicy(
      target,
      new DestinationPolicy(this.origin),
    );
    let session: BrowserSession | undefined;
    const abort = () => {
      void session?.close().catch(() => {});
    };
    signal.addEventListener('abort', abort, { once: true });
    try {
      signal.throwIfAborted();
      session = await this.sessions(policy).create();
      signal.throwIfAborted();
      // Disable page scripts before navigation and keep them disabled until disposal.
      // All extraction/security classification below uses Chromium protocol data.
      const fence = await suspendPageScripts(session.page);
      let domGeneration = 0;
      for (const event of [
        'DOM.documentUpdated',
        'DOM.attributeModified',
        'DOM.attributeRemoved',
        'DOM.characterDataModified',
        'DOM.childNodeInserted',
        'DOM.childNodeRemoved',
        'DOM.childNodeCountUpdated',
        'DOM.shadowRootPushed',
        'DOM.shadowRootPopped',
      ] as const)
        fence.cdp.on(event, () => {
          domGeneration++;
        });
      await fence.cdp.send('DOM.enable');
      const response = await session.page.goto(target, {
        waitUntil: 'domcontentloaded',
        timeout: 5000,
      });
      await session.securityCheck();
      const baseline = session.securitySnapshot();
      const security = await inspectSecurityControls(session.page, fence.cdp);
      const baselineDom = domGeneration;
      if (session.page.url() !== target || response?.status() !== 200)
        return uncertain('NO_TRUSTWORTHY_STATUS_PAGE');
      const tree = await fence.cdp.send('DOM.getDocument', {
        depth: -1,
        pierce: true,
      });
      const topology = inspectReceiptTopology(tree.root);
      let issue: string | undefined;
      const candidates: VerificationEvidence[] = [];
      for (const node of topology.receipts) {
        const attrs = attributes(node);
        let identityMismatch = false;
        for (const [key, value] of Object.entries(evidenceIdentity(context)))
          if (attrs.get(`data-${key.toLowerCase()}`) !== value)
            identityMismatch = true;
        if (
          attrs.get('data-platform') !== context.platform ||
          attrs.get('data-destination') !== context.destination
        )
          identityMismatch = true;
        if (identityMismatch) {
          issue = 'VERIFICATION_IDENTITY_MISMATCH';
          continue;
        }
        const outcome = attrs.get('data-outcome'),
          identifier = attrs.get('data-receipt'),
          issuedAt = attrs.get('data-serverissuedat');
        const text = (node.children ?? [])
          .filter((child) => child.nodeName === '#text')
          .map((child) => child.nodeValue)
          .join('')
          .trim();
        const expected = {
          CONFIRMED: 'Application received',
          REJECTED: 'Application rejected',
          UNKNOWN: 'No application found',
        };
        if (
          !outcome ||
          !(outcome in expected) ||
          text !== expected[outcome as keyof typeof expected] ||
          (outcome !== 'UNKNOWN' &&
            (!identifier ||
              !/^[A-Za-z0-9_-]{16,200}$/.test(identifier) ||
              identifier === context.mutationId ||
              identifier === `receipt-${context.mutationId}` ||
              !issuedAt ||
              !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(issuedAt) ||
              !Number.isFinite(Date.parse(issuedAt)) ||
              Date.parse(issuedAt) < Date.parse(context.submissionStartedAt) ||
              Date.parse(issuedAt) > Date.now()))
        ) {
          issue = 'INVALID_CONFIRMATION_IDENTIFIER';
          continue;
        }
        candidates.push({
          ...evidenceIdentity(context),
          type: 'STATUS_PAGE',
          source: 'LOCAL_FIXTURE',
          strength: outcome === 'UNKNOWN' ? 'MEDIUM' : 'WEAK',
          capturedAt: new Date().toISOString(),
          pageUrl: target,
          httpStatus: response.status(),
          confirmationFingerprint: digest(
            JSON.stringify([...attrs].sort()) + text,
          ),
          ...(identifier ? { receiptId: identifier } : {}),
          evidenceOrigin: 'SERVER_STATUS',
          ...(issuedAt ? { serverIssuedAt: issuedAt } : {}),
          outcome: outcome as VerificationEvidence['outcome'],
        });
      }
      // Candidate observations remain weak until the entire window is fenced.
      evidence.push(...candidates);
      const finalSecurity = await inspectSecurityControls(
        session.page,
        fence.cdp,
      );
      const finalTree = await fence.cdp.send('DOM.getDocument', {
        depth: -1,
        pierce: true,
      });
      const finalTopology = inspectReceiptTopology(finalTree.root);
      await session.securityCheck();
      const finalNetwork = session.securitySnapshot();
      signal.throwIfAborted();
      if (
        finalNetwork.violations ||
        finalNetwork.pending ||
        domGeneration !== baselineDom ||
        finalNetwork.generation !== baseline.generation
      )
        return uncertain('VERIFICATION_SECURITY_STATE_CHANGED');
      if (security.captcha || finalSecurity.captcha)
        return uncertain('CHALLENGE_DURING_VERIFICATION');
      if (security.authentication || finalSecurity.authentication)
        return uncertain('AUTHENTICATION_DURING_VERIFICATION');
      // No extra renderer is allowed to run outside the main renderer script fence.
      if (
        !security.complete ||
        !finalSecurity.complete ||
        !topology.complete ||
        !finalTopology.complete ||
        session.page.frames().length !== 1
      )
        return uncertain('SECURITY_INSPECTION_INCOMPLETE');
      if (
        session.page.url() !== target ||
        security.surroundingDomDigest !== finalSecurity.surroundingDomDigest ||
        topology.fingerprint !== finalTopology.fingerprint
      )
        return uncertain('VERIFICATION_OBSERVATION_STALE');
      if (issue) return uncertain(issue);
      if (topology.receipts.length > 1) return uncertain('AMBIGUOUS_RECEIPTS');
      // End all browser activity before promoting evidence. Rejections arising
      // during disposal are observed synchronously, with no subsequent async gap.
      await session.close();
      const disposed = session.securitySnapshot();
      signal.throwIfAborted();
      if (
        disposed.violations ||
        disposed.pending ||
        domGeneration !== baselineDom ||
        disposed.generation !== finalNetwork.generation
      )
        return uncertain('VERIFICATION_SECURITY_STATE_CHANGED');
      session = undefined;
      // A completely safe generic page is weaker uncertainty and cannot erase
      // prior external proof. Policy violations and incomplete reads still veto it.
      if (!topology.receipts.length)
        return uncertain('NO_TRUSTWORTHY_STATUS_PAGE', false);
      for (const candidate of candidates) {
        candidate.capturedAt = new Date().toISOString();
        candidate.inspectionComplete = true;
        candidate.securityGeneration = finalNetwork.generation;
        if (candidate.outcome !== 'UNKNOWN') candidate.strength = 'STRONG';
      }
      return {
        evidence,
        reason:
          candidates[0]?.outcome === 'UNKNOWN'
            ? 'NO_APPLICATION_FOUND'
            : 'IDENTITY_BOUND_FIXTURE_STATUS',
      };
    } catch (error) {
      return {
        ...uncertain(
          signal.aborted
            ? 'VERIFICATION_TIMEOUT'
            : error instanceof InspectionError
              ? error.code
              : 'VERIFICATION_NAVIGATION_FAILED',
        ),
        ...(error instanceof InspectionError &&
        ['BROWSER_LAUNCH_FAILED', 'DNS_FAILURE'].includes(error.code)
          ? { infrastructureFailure: true }
          : {}),
      };
    } finally {
      signal.removeEventListener('abort', abort);
      await session?.close().catch(() => {});
    }
  }
}
