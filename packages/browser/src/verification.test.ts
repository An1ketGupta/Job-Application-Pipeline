import { describe, expect, it, vi } from 'vitest';
import {
  GenericSubmissionVerifier,
  LocalFixtureSubmissionVerifier,
  inspectReceiptTopology,
} from './verifier.js';
import { BrowserApplicationExecutor } from './executor.js';
import {
  reconcileEvidence,
  type VerificationContext,
} from '@careerlift/domain';
import {
  executionFixture,
  fixtureHtml,
} from '../../../tests/support/execution-fixture.js';
import type { BrowserNetworkPolicy } from './policy.js';
import type { BrowserSession } from './session.js';
import type { CDPSession } from 'playwright';
import {
  fixtureStatusPage,
  fixtureVerificationContext,
} from '../../../tests/support/verification-fixture.js';

describe('read-only local HTTPS verification', () => {
  it.each([
    'confirmation',
    'rejection',
    'absence',
    'generic-200',
    'redirect',
    'private-redirect',
    'challenge',
    'authentication',
    'wrong-job',
    'wrong-user',
    'wrong-execution',
    'wrong-identifier',
    'stale',
    'malicious',
    'timeout',
    'navigation-failure',
  ] as const)(
    'handles %s after one dropped POST without resubmission',
    async (scenario) => {
      const fixture = await executionFixture();
      fixture.setOutcome('unknown');
      const executor = new BrowserApplicationExecutor({
        documents: fixture.storage,
        fixtureOrigin: fixture.origin,
        receiptTimeoutMs: 200,
      });
      try {
        const result = await executor.execute(fixture.input);
        expect(result.status).toBe('SUBMISSION_UNKNOWN');
        expect(fixture.submissions).toHaveLength(1);
        const context = fixtureVerificationContext(fixture.input, result);
        let page = fixtureStatusPage(
          context,
          scenario === 'rejection'
            ? 'REJECTED'
            : scenario === 'absence'
              ? 'UNKNOWN'
              : 'CONFIRMED',
        );
        if (scenario.startsWith('wrong-') && scenario !== 'wrong-identifier') {
          const key = {
            'wrong-job': 'jobId',
            'wrong-user': 'userId',
            'wrong-execution': 'executionId',
          }[scenario as 'wrong-job'] as keyof VerificationContext;
          page = fixtureStatusPage({ ...context, [key]: 'another-identity' });
        }
        if (scenario === 'wrong-identifier')
          page = page.replace(/data-receipt="[^"]*"/, 'data-receipt=""');
        if (scenario === 'stale')
          page = fixtureStatusPage({
            ...context,
            submissionStartedAt: '2026-01-01T00:00:00.000Z',
          });
        if (scenario === 'generic-200')
          page = '<p>Thank you for applying! Application received</p>';
        if (scenario === 'challenge')
          page += '<div id="captcha">Verify you are human</div>';
        if (scenario === 'authentication') page += '<input type="password">';
        if (scenario === 'malicious')
          page = `<p>Application received</p><script>fetch('/submit',{method:'POST',body:'duplicate'});document.querySelector=()=>({textContent:'Application received'});</script>`;
        if (scenario === 'redirect')
          fixture.setStatusRedirect(`${fixture.origin}/apply`);
        if (scenario === 'private-redirect')
          fixture.setStatusRedirect('https://169.254.169.254/latest/meta-data');
        if (scenario === 'timeout') fixture.setStatusDelay(2000);
        if (scenario === 'navigation-failure')
          fixture.setStatusRedirect('https://does-not-exist.invalid/');
        fixture.setStatusHtml(page);
        const verifier = new LocalFixtureSubmissionVerifier(
          fixture.origin,
          fixture.sessions,
        );
        const controller = new AbortController();
        const timer =
          scenario === 'timeout'
            ? setTimeout(() => controller.abort(), 500)
            : undefined;
        const observation = await verifier.verify(context, controller.signal);
        if (timer) clearTimeout(timer);
        const decision = reconcileEvidence(context, observation.evidence);
        expect(decision.state, observation.reason).toBe(
          scenario === 'confirmation'
            ? 'CONFIRMED'
            : scenario === 'rejection'
              ? 'REJECTED'
              : 'HUMAN_REQUIRED',
        );
        if (scenario === 'challenge')
          expect(observation.reason).toBe('CHALLENGE_DURING_VERIFICATION');
        if (scenario === 'authentication')
          expect(observation.reason).toBe('AUTHENTICATION_DURING_VERIFICATION');
        if (scenario === 'timeout')
          expect(observation.reason).toBe('VERIFICATION_TIMEOUT');
        expect(fixture.submissions).toHaveLength(1);
        expect(fixture.nextMutations).toHaveLength(0);
      } finally {
        await executor.close();
        await fixture.close();
      }
    },
    30000,
  );
  it('does not claim a production platform or inspect arbitrary destinations', async () => {
    const fixture = await executionFixture();
    try {
      const executor = new BrowserApplicationExecutor({
        documents: fixture.storage,
        fixtureOrigin: fixture.origin,
      });
      const result = await executor.execute(fixture.input);
      await executor.close();
      const context = fixtureVerificationContext(fixture.input, result);
      const generic = await new GenericSubmissionVerifier().verify(context);
      expect(generic.evidence[0]).toMatchObject({
        type: 'HTTP_SUCCESS',
        strength: 'WEAK',
        httpStatus: 200,
      });
      expect(reconcileEvidence(context, generic.evidence).state).toBe(
        'HUMAN_REQUIRED',
      );
      expect(
        new LocalFixtureSubmissionVerifier(fixture.origin).supports({
          ...context,
          mode: 'REAL_EXECUTION',
        }),
      ).toBe(false);
    } finally {
      await fixture.close();
    }
  }, 30000);
});

describe('Phase 5.1 verification integrity', () => {
  it.each([
    200, 201, 202, 204, 301, 302, 400, 401, 403, 404, 409, 422, 500, 502, 503,
  ])(
    'transport %s and a synthetic executor receipt remain weak',
    async (status) => {
      const context: VerificationContext = {
        userId: 'owner',
        executionId: 'execution',
        applicationId: 'application',
        jobId: 'job',
        company: 'Example',
        jobTitle: 'Engineer',
        platform: 'GENERIC',
        mode: 'TEST_FIXTURE',
        destination: 'https://127.0.0.1:4444/submit',
        mutationId: 'mutation',
        stepId: 'step',
        requestFingerprint: 'a'.repeat(64),
        documentDigests: [],
        submissionStartedAt: new Date().toISOString(),
        mutationOutcome: 'FORWARDED',
        responseStatus: status,
        responseReceivedAt: new Date().toISOString(),
        fixtureReceipt: 'CONFIRMED',
      };
      const result = await new GenericSubmissionVerifier().verify(context);
      expect(result.evidence.every((e) => e.strength === 'WEAK')).toBe(true);
      expect(reconcileEvidence(context, result.evidence).state).toBe(
        'HUMAN_REQUIRED',
      );
      const local = new LocalFixtureSubmissionVerifier(
        'https://127.0.0.1:4444',
        () => ({
          create: async () => {
            throw new Error('No external status service');
          },
        }),
      );
      const observed = await local.verify(
        context,
        new AbortController().signal,
      );
      expect(observed.evidence.some((e) => e.strength === 'STRONG')).toBe(
        false,
      );
      expect(reconcileEvidence(context, observed.evidence).state).toBe(
        'HUMAN_REQUIRED',
      );
    },
  );

  it.each(['success', 'failure'] as const)(
    'F1: %s POST plus pre-existing success cannot confirm',
    async (outcome) => {
      const fixture = await executionFixture();
      fixture.setOutcome(outcome);
      fixture.setHtml(
        (await fixtureHtml('simple'))
          .replace('<div id="success" hidden>', '<div id="success">')
          .replace("response.ok ? 'success' : 'failure'", "'success'"),
      );
      const executor = new BrowserApplicationExecutor({
        documents: fixture.storage,
        fixtureOrigin: fixture.origin,
      });
      try {
        const executed = await executor.execute(fixture.input);
        const context = {
          ...fixtureVerificationContext(fixture.input, executed),
          fixtureReceipt: 'CONFIRMED' as const,
        };
        expect(context.responseStatus).toBe(outcome === 'success' ? 200 : 422);
        fixture.setStatusHtml(fixtureStatusPage(context, 'UNKNOWN'));
        const result = await new LocalFixtureSubmissionVerifier(
          fixture.origin,
          fixture.sessions,
        ).verify(context, new AbortController().signal);
        expect(reconcileEvidence(context, result.evidence).state).toBe(
          'HUMAN_REQUIRED',
        );
        expect(result.evidence.some((e) => e.strength === 'STRONG')).toBe(
          false,
        );
        expect(fixture.submissions).toHaveLength(1);
      } finally {
        await executor.close();
        await fixture.close();
      }
    },
    30000,
  );

  it('F1: server creates an independent acceptance artifact only after the actual POST', async () => {
    const fixture = await executionFixture();
    fixture.setOutcome('unknown');
    const executor = new BrowserApplicationExecutor({
      documents: fixture.storage,
      fixtureOrigin: fixture.origin,
      receiptTimeoutMs: 100,
    });
    let beforePostChecked = false;
    try {
      const executed = await executor.execute(fixture.input, {
        persist: async (progress) => {
          if (
            beforePostChecked ||
            !progress.mutations?.some(
              (m) => m.action === 'FINAL_SUBMIT' && m.outcome === 'DISPATCHING',
            )
          )
            return;
          const context = fixtureVerificationContext(fixture.input, progress);
          fixture.bindStatusIdentity(context);
          const before = await new LocalFixtureSubmissionVerifier(
            fixture.origin,
            fixture.sessions,
          ).verify(context, new AbortController().signal);
          expect(fixture.submissions).toHaveLength(0);
          expect(reconcileEvidence(context, before.evidence).state).toBe(
            'HUMAN_REQUIRED',
          );
          beforePostChecked = true;
        },
      });
      expect(beforePostChecked).toBe(true);
      const context = fixtureVerificationContext(fixture.input, executed);
      const observed = await new LocalFixtureSubmissionVerifier(
        fixture.origin,
        fixture.sessions,
      ).verify(context, new AbortController().signal);
      expect(
        reconcileEvidence(context, observed.evidence).state,
        observed.reason,
      ).toBe('CONFIRMED');
      const receipt = observed.evidence.find((e) => e.strength === 'STRONG')!;
      expect(receipt.receiptId).not.toBe(`receipt-${context.mutationId}`);
      expect(receipt.receiptId).not.toBe(context.mutationId);
      expect(receipt.evidenceOrigin).toBe('SERVER_STATUS');
      expect(fixture.submissions).toHaveLength(1);
    } finally {
      await executor.close();
      await fixture.close();
    }
  }, 30000);

  it('F2: bounds traversal of shadow → frame → shadow protocol edges and missing documents', () => {
    const receipt = {
      nodeName: 'SECTION',
      nodeValue: '',
      attributes: ['id', 'careerlift-receipt'],
    };
    const root = {
      nodeName: '#document',
      nodeValue: '',
      shadowRoots: [
        {
          nodeName: '#document-fragment',
          nodeValue: '',
          children: [
            {
              nodeName: 'IFRAME',
              nodeValue: '',
              contentDocument: {
                nodeName: '#document',
                nodeValue: '',
                shadowRoots: [
                  {
                    nodeName: '#document-fragment',
                    nodeValue: '',
                    children: [receipt],
                  },
                ],
              },
            },
          ],
        },
      ],
    };
    expect(inspectReceiptTopology(root).receipts).toEqual([receipt]);
    expect(inspectReceiptTopology(root).complete).toBe(true);
    expect(
      inspectReceiptTopology({ nodeName: 'FRAME', nodeValue: '' }).complete,
    ).toBe(false);
    expect(() =>
      inspectReceiptTopology({
        nodeName: '#document',
        nodeValue: '',
        children: Array.from({ length: 10001 }, () => receipt),
      }),
    ).toThrow('limit');
  });

  it.each([
    'shadow-rejected',
    'frame-rejected',
    'shadow-duplicate',
    'frame-only',
    'nested',
    'limit',
    'wrong-mutation',
  ] as const)(
    'F2/F1: %s cannot become confirmation',
    async (scenario) => {
      const fixture = await executionFixture();
      fixture.setOutcome('unknown');
      const executor = new BrowserApplicationExecutor({
        documents: fixture.storage,
        fixtureOrigin: fixture.origin,
        receiptTimeoutMs: 100,
      });
      try {
        const executed = await executor.execute(fixture.input);
        const context = fixtureVerificationContext(fixture.input, executed);
        const section = (outcome: 'CONFIRMED' | 'REJECTED') =>
          fixtureStatusPage(context, outcome).match(
            /<section[^]*<\/section>/,
          )![0];
        const frame = (html: string) =>
          `<iframe srcdoc="${html.replaceAll('&', '&amp;').replaceAll('"', '&quot;')}"></iframe>`;
        let html = fixtureStatusPage(context);
        if (scenario === 'shadow-rejected' || scenario === 'shadow-duplicate')
          html += `<div><template shadowrootmode="open">${section(scenario === 'shadow-rejected' ? 'REJECTED' : 'CONFIRMED')}</template></div>`;
        if (scenario === 'frame-rejected') html += frame(section('REJECTED'));
        if (scenario === 'frame-only') html = frame(section('CONFIRMED'));
        if (scenario === 'nested')
          html = `<div><template shadowrootmode="open">${frame(`<div><template shadowrootmode="open">${section('CONFIRMED')}</template></div>`)}</template></div>`;
        if (scenario === 'limit') html += '<span>x</span>'.repeat(10001);
        if (scenario === 'wrong-mutation')
          html = fixtureStatusPage({
            ...context,
            mutationId: 'another-mutation',
          });
        fixture.setStatusHtml(html);
        const observed = await new LocalFixtureSubmissionVerifier(
          fixture.origin,
          fixture.sessions,
        ).verify(context, new AbortController().signal);
        const decision = reconcileEvidence(context, observed.evidence);
        expect(decision.state, observed.reason).toBe('HUMAN_REQUIRED');
        if (scenario === 'shadow-rejected' || scenario === 'frame-rejected') {
          expect(
            observed.evidence
              .filter((e) => e.type === 'STATUS_PAGE')
              .map((e) => e.outcome)
              .sort(),
          ).toEqual(['CONFIRMED', 'REJECTED']);
          expect(decision.reason).toBe('CONFLICTING_EVIDENCE');
        }
        if (scenario === 'shadow-duplicate')
          expect(observed.reason).toBe('AMBIGUOUS_RECEIPTS');
        if (scenario === 'limit')
          expect(observed.reason).toBe('VERIFICATION_DOM_LIMIT');
        expect(fixture.submissions).toHaveLength(1);
      } finally {
        await executor.close();
        await fixture.close();
      }
    },
    30000,
  );

  it.each([
    'metadata',
    'private-network',
    'redirect',
    'challenge',
    'incomplete',
    'late-challenge-gap',
    'late-inspection-gap',
    'teardown-request',
  ] as const)(
    'F3: %s injected after receipt extraction fails closed',
    async (attack) => {
      const fixture = await executionFixture();
      fixture.setOutcome('unknown');
      const executor = new BrowserApplicationExecutor({
        documents: fixture.storage,
        fixtureOrigin: fixture.origin,
        receiptTimeoutMs: 100,
      });
      const restorers: (() => void)[] = [];
      try {
        const executed = await executor.execute(fixture.input);
        const context = fixtureVerificationContext(fixture.input, executed);
        fixture.setStatusHtml(fixtureStatusPage(context));
        let injected = false,
          blocked = false;
        const sessions = (policy: BrowserNetworkPolicy) => ({
          create: async (): Promise<BrowserSession> => {
            const instrumentedPolicy: BrowserNetworkPolicy = {
              validateNavigation: (url) => policy.validateNavigation(url),
              validateRequest: (url, method) => {
                try {
                  policy.validateRequest(url, method);
                } catch (error) {
                  blocked = true;
                  throw error;
                }
              },
              validateAddress: (url) => policy.validateAddress(url),
              validateConnectedAddress: (url, address) =>
                policy.validateConnectedAddress(url, address),
            };
            const session = await fixture.sessions(instrumentedPolicy).create();
            const originalNew = session.context.newCDPSession.bind(
              session.context,
            );
            let reads = 0;
            const inject = async (cdp: CDPSession, rootId?: number) => {
              injected = true;
              if (
                ['metadata', 'private-network', 'teardown-request'].includes(
                  attack,
                )
              ) {
                // Test-only protocol injection: no page script or selector executes.
                const url =
                  attack === 'private-network'
                    ? 'https://10.0.0.1/private'
                    : 'https://169.254.169.254/latest/meta-data';
                const requested = new Promise<void>((resolve) =>
                  session.page.once('requestfailed', () => resolve()),
                );
                await cdp.send('DOM.setOuterHTML', {
                  nodeId: rootId!,
                  outerHTML: fixtureStatusPage(context).replace(
                    '</body>',
                    `<img src="${url}"></body>`,
                  ),
                });
                await requested;
              } else if (attack === 'redirect') {
                await session.page
                  .goto('https://169.254.169.254/latest/meta-data')
                  .catch(() => {});
              } else {
                const html = ['challenge', 'late-challenge-gap'].includes(
                  attack,
                )
                  ? fixtureStatusPage(context) +
                    '<div id="captcha">Verify you are human</div>'
                  : fixtureStatusPage(context) +
                    '<custom-security-region></custom-security-region>';
                await cdp.send('DOM.setOuterHTML', {
                  nodeId: rootId!,
                  outerHTML: html,
                });
              }
            };
            const spy = vi
              .spyOn(session.context, 'newCDPSession')
              .mockImplementation(async (...args) => {
                const cdp = await originalNew(...args);
                const send = cdp.send.bind(cdp);
                const sendSpy = vi
                  .spyOn(cdp, 'send')
                  .mockImplementation((async (
                    method: string,
                    params: never,
                  ) => {
                    const value = await send(method as never, params);
                    if (
                      method === 'DOM.getDocument' &&
                      ++reads ===
                        (['late-challenge-gap', 'late-inspection-gap'].includes(
                          attack,
                        )
                          ? 4
                          : 2) &&
                      attack !== 'teardown-request'
                    ) {
                      const root = (
                        value as unknown as {
                          root: {
                            children: { nodeId: number; nodeName: string }[];
                          };
                        }
                      ).root;
                      const htmlId = root.children.find(
                        (n) => n.nodeName === 'HTML',
                      )!.nodeId;
                      await inject(cdp, htmlId);
                    }
                    return value;
                  }) as CDPSession['send']);
                restorers.push(() => sendSpy.mockRestore());
                return cdp;
              });
            restorers.push(() => spy.mockRestore());
            if (attack === 'teardown-request') {
              const close = session.close.bind(session);
              session.close = async () => {
                if (!injected) {
                  const cdp = await originalNew(session.page);
                  const tree = await cdp.send('DOM.getDocument', { depth: 1 });
                  await inject(
                    cdp,
                    tree.root.children!.find((n) => n.nodeName === 'HTML')!
                      .nodeId,
                  );
                }
                await close();
              };
            }
            return session;
          },
        });
        const observed = await new LocalFixtureSubmissionVerifier(
          fixture.origin,
          sessions,
        ).verify(context, new AbortController().signal);
        expect(injected).toBe(true);
        if (
          [
            'metadata',
            'private-network',
            'redirect',
            'teardown-request',
          ].includes(attack)
        )
          expect(blocked).toBe(true);
        expect(
          reconcileEvidence(context, observed.evidence).state,
          observed.reason,
        ).toBe('HUMAN_REQUIRED');
        expect(observed.evidence.some((e) => e.strength === 'STRONG')).toBe(
          false,
        );
        expect(fixture.submissions).toHaveLength(1);
      } finally {
        restorers.reverse().forEach((restore) => restore());
        await executor.close();
        await fixture.close();
      }
    },
    30000,
  );
});
