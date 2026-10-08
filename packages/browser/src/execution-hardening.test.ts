import { describe, expect, it } from 'vitest';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { ExecutionResult } from '@careerlift/domain';
import { BrowserApplicationExecutor } from './executor.js';
import { ApplicationInspector } from './inspector.js';
import { BrowserSessionManager } from './session.js';
import { ExecutionNetworkPolicy } from './execution-policy.js';
import { inspectSecurityControls } from './security-controls.js';
import { suspendPageScripts } from './trusted-dom.js';
import { bindContract, digest } from './mutation-contract.js';
import {
  executionFixture,
  fixtureHtml,
} from '../../../tests/support/execution-fixture.js';

const tamperPayload = (html: string, tampering: string) =>
  html
    .replace(
      'const response = await fetch',
      `const payload = new FormData(event.target); ${tampering} const response = await fetch`,
    )
    .replace('body: new FormData(event.target),', 'body: payload,');

describe('Phase 4.2 trusted DOM and sticky human review boundaries', () => {
  it('H3 browser script suspension stops a pending page challenge timer', async () => {
    const fixture = await executionFixture();
    const session = await new BrowserSessionManager(
      true,
      fixture.policy,
      true,
    ).create();
    let fence: Awaited<ReturnType<typeof suspendPageScripts>> | undefined;
    try {
      await session.page.goto(`${fixture.origin}/apply`);
      await session.page.evaluate(() => {
        setTimeout(() => {
          const challenge = document.createElement('div');
          challenge.id = 'captcha';
          challenge.textContent = 'Verify you are human';
          document.body.append(challenge);
        }, 100);
      });
      fence = await suspendPageScripts(session.page);
      await new Promise((resolve) => setTimeout(resolve, 250));
      const security = await inspectSecurityControls(session.page);
      expect(security.complete).toBe(true);
      expect(security.captcha).toBe(false);
      expect(fixture.submissions).toHaveLength(0);
    } finally {
      await fence?.release();
      await session.close();
      await fixture.close();
    }
  }, 30000);

  it('H1 fails closed when all page renderers cannot be fenced', async () => {
    const fixture = await executionFixture();
    fixture.setHtml(
      (await fixtureHtml('simple')).replace(
        '</body>',
        '<iframe src="about:blank"></iframe></body>',
      ),
    );
    const executor = new BrowserApplicationExecutor({
      documents: fixture.storage,
      fixtureOrigin: fixture.origin,
      sessions: fixture.sessions,
    });
    try {
      const result = await executor.execute(fixture.input);
      expect(['BLOCKED', 'PAUSED_HUMAN_REQUIRED']).toContain(result.status);
      expect(result.error).toBe('SECURITY_INSPECTION_INCOMPLETE');
      expect(
        result.steps.filter(
          (step) => step.type === 'FILL_FIELD' && step.status === 'COMPLETED',
        ),
      ).toHaveLength(0);
      expect(fixture.submissions).toHaveLength(0);
    } finally {
      await executor.close();
      await fixture.close();
    }
  }, 30000);

  it.each([
    'prototype setter',
    'own setter',
    'proxy setter',
    'beforeinput',
    'input',
    'change',
    'delegated input',
  ])(
    'H1 rejects %s before any prepared value enters a redirected control',
    async (attack) => {
      const fixture = await executionFixture();
      const executor = new BrowserApplicationExecutor({
        documents: fixture.storage,
        fixtureOrigin: fixture.origin,
        sessions: fixture.sessions,
      });
      let installed = false;
      let captured:
        | { name: string; type: string; value: string; redirected: string }
        | undefined;
      try {
        const result = await executor.execute(fixture.input, {
          persist: async (state) => {
            if (
              installed ||
              state.steps.at(-1)?.type !== 'FILL_FIELD' ||
              state.steps.at(-1)?.status !== 'RUNNING'
            )
              return;
            installed = true;
            const session = fixture.getSession()!;
            await session.page.evaluate((attack) => {
              const target = document.getElementById(
                'first',
              ) as HTMLInputElement;
              const native = Object.getOwnPropertyDescriptor(
                HTMLInputElement.prototype,
                'value',
              )!;
              const redirect = function (
                this: HTMLInputElement,
                value: string,
              ) {
                this.name = 'salary';
                this.type = 'password';
                native.set!.call(this, value);
              };
              if (attack === 'prototype setter')
                Object.defineProperty(HTMLInputElement.prototype, 'value', {
                  ...native,
                  set: redirect,
                });
              else if (attack === 'own setter')
                Object.defineProperty(target, 'value', {
                  ...native,
                  set: redirect,
                });
              else if (attack === 'proxy setter')
                Object.defineProperty(HTMLInputElement.prototype, 'value', {
                  ...native,
                  set: new Proxy(native.set!, {
                    apply: (_setter, control, args) =>
                      redirect.call(control, args[0]),
                  }),
                });
              else {
                const password = document.createElement('input');
                password.id = 'redirected';
                password.name = 'salary';
                document.body.append(password);
                (attack === 'delegated input'
                  ? document
                  : target
                ).addEventListener(
                  attack === 'delegated input' ? 'input' : attack,
                  () => {
                    password.value = target.value;
                    password.type = 'password';
                    target.name = 'salary';
                    target.type = 'password';
                  },
                );
              }
            }, attack);
            const close = session.close;
            session.close = async () => {
              captured = await session.page.evaluate(() => {
                const field = document.getElementById(
                  'first',
                ) as HTMLInputElement;
                return {
                  name: field.name,
                  type: field.type,
                  value: field.value,
                  redirected:
                    (
                      document.getElementById(
                        'redirected',
                      ) as HTMLInputElement | null
                    )?.value ?? '',
                };
              });
              await close();
            };
          },
        });
        expect(installed).toBe(true);
        expect(result.status, JSON.stringify(result)).toBe('BLOCKED');
        expect(result.error).toBe('UNTRUSTED_FIELD_HOOK');
        expect(captured?.value).toBe('');
        expect(captured?.redirected).toBe('');
        expect(captured?.name).toBe('first');
        expect(captured?.type).toBe('text');
        expect(fixture.submissions).toHaveLength(0);
      } finally {
        await executor.close();
        await fixture.close();
      }
    },
    30000,
  );

  it.each([
    'password',
    'file',
    'salary',
    'sponsorship',
    'workAuthorization',
    'identical clone',
  ])(
    'H1 rejects replacement with %s without retargeting the original node',
    async (replacement) => {
      const fixture = await executionFixture();
      const executor = new BrowserApplicationExecutor({
        documents: fixture.storage,
        fixtureOrigin: fixture.origin,
        sessions: fixture.sessions,
      });
      let changed = false;
      let value: string | undefined;
      try {
        const result = await executor.execute(fixture.input, {
          persist: async (state) => {
            if (
              changed ||
              state.steps.at(-1)?.type !== 'FILL_FIELD' ||
              state.steps.at(-1)?.status !== 'RUNNING'
            )
              return;
            changed = true;
            const session = fixture.getSession()!;
            await session.page
              .locator('#first')
              .evaluate((element, replacement) => {
                const clone = element.cloneNode(true) as HTMLInputElement;
                if (['password', 'file'].includes(replacement))
                  clone.type = replacement;
                else if (replacement !== 'identical clone')
                  clone.name = replacement;
                element.replaceWith(clone);
              }, replacement);
            const close = session.close;
            session.close = async () => {
              value = await session.page.locator('#first').inputValue();
              await close();
            };
          },
        });
        expect(changed).toBe(true);
        expect(result.status, JSON.stringify(result)).toBe('BLOCKED');
        expect(result.error).toBe('STALE_DOM_FIELD');
        expect(value).toBe('');
        expect(fixture.submissions).toHaveLength(0);
      } finally {
        await executor.close();
        await fixture.close();
      }
    },
    30000,
  );

  it('H1 isolated property writes emit no page events or attribute mutations', async () => {
    const fixture = await executionFixture();
    const executor = new BrowserApplicationExecutor({
      documents: fixture.storage,
      fixtureOrigin: fixture.origin,
      sessions: fixture.sessions,
    });
    let installed = false;
    let observations = -1;
    try {
      const result = await executor.execute(fixture.input, {
        persist: async (state) => {
          if (
            installed ||
            state.steps.at(-1)?.type !== 'FILL_FIELD' ||
            state.steps.at(-1)?.status !== 'RUNNING'
          )
            return;
          installed = true;
          const session = fixture.getSession()!;
          await session.page.evaluate(() => {
            const target = document.getElementById('first') as HTMLInputElement;
            const extra = document.createElement('input');
            extra.id = 'redirected';
            extra.name = 'salary';
            extra.hidden = true;
            document.body.append(extra);
            (window as unknown as { observations: number }).observations = 0;
            new MutationObserver(() => {
              (window as unknown as { observations: number }).observations++;
              extra.value = target.value;
              extra.type = 'password';
            }).observe(target, {
              attributes: true,
              childList: true,
              subtree: true,
            });
          });
          const close = session.close;
          session.close = async () => {
            observations = await session.page.evaluate(
              () =>
                (window as unknown as { observations: number }).observations,
            );
            expect(await session.page.locator('#redirected').inputValue()).toBe(
              '',
            );
            await close();
          };
        },
      });
      expect(result.status, JSON.stringify(result)).toBe('SUBMITTED');
      expect(observations).toBe(0);
      expect(fixture.submissions).toHaveLength(1);
    } finally {
      await executor.close();
      await fixture.close();
    }
  }, 30000);

  it.each([
    'relabel',
    'empty text',
    'hidden',
    'move',
    'attributes',
    'replacement',
    'changed replacement',
    'relocated replacement',
    'traversal override',
  ])(
    'H3 preserves the immutable unresolved requirement after %s',
    async (attack) => {
      const fixture = await executionFixture();
      fixture.setHtml(
        (await fixtureHtml('simple')).replace(
          '</body>',
          '<div id="challenge" data-unresolved="true">Verify you are human</div></body>',
        ),
      );
      const executor = new BrowserApplicationExecutor({
        documents: fixture.storage,
        fixtureOrigin: fixture.origin,
        sessions: fixture.sessions,
      });
      try {
        const paused = await executor.execute(fixture.input);
        expect(paused.status).toBe('PAUSED_HUMAN_REQUIRED');
        const requirement = structuredClone(
          paused.checkpoint!.reviewRequirement!,
        );
        expect(requirement.controls?.length).toBeGreaterThan(0);
        await fixture.getSession()!.page.evaluate((attack) => {
          const challenge = document.getElementById('challenge')!;
          if (attack === 'relabel')
            challenge.textContent = 'Complete this puzzle to continue';
          else if (attack === 'empty text') challenge.textContent = '';
          else if (attack === 'hidden') challenge.hidden = true;
          else if (attack === 'move') {
            const filler = document.createElement('div');
            filler.textContent = 'safe '.repeat(30000);
            document.body.append(filler, challenge);
            challenge.hidden = true;
          } else if (attack === 'attributes') {
            challenge.removeAttribute('id');
            challenge.removeAttribute('data-unresolved');
            challenge.textContent = 'Continue after the puzzle';
          } else if (
            attack === 'replacement' ||
            attack === 'changed replacement' ||
            attack === 'relocated replacement'
          ) {
            const clone = challenge.cloneNode(true) as HTMLElement;
            clone.textContent = 'Complete this puzzle to continue';
            if (
              attack === 'changed replacement' ||
              attack === 'relocated replacement'
            ) {
              clone.id = 'unrecognized';
              clone.removeAttribute('data-unresolved');
            }
            if (attack === 'relocated replacement') {
              challenge.remove();
              document.querySelector('form')!.append(clone);
            } else challenge.replaceWith(clone);
          } else {
            challenge.hidden = true;
            const getter = Object.getOwnPropertyDescriptor(
              Node.prototype,
              'childNodes',
            )!.get!;
            Object.defineProperty(Node.prototype, 'childNodes', {
              configurable: true,
              get() {
                const children = getter.call(this);
                return this === document.body
                  ? Array.from(children).filter((node) => node !== challenge)
                  : children;
              },
            });
            document.querySelectorAll =
              (() => []) as unknown as typeof document.querySelectorAll;
          }
        }, attack);
        const resumed = await executor.execute({
          ...fixture.input,
          previousResult: paused,
        });
        expect(resumed.status, JSON.stringify(resumed)).toBe(
          'PAUSED_HUMAN_REQUIRED',
        );
        expect(resumed.checkpoint!.reviewRequirement).toEqual(requirement);
        expect(fixture.submissions).toHaveLength(0);
      } finally {
        await executor.close();
        await fixture.close();
      }
    },
    30000,
  );

  it('H3 permits original-session resume only after positive trusted container removal', async () => {
    const fixture = await executionFixture();
    fixture.setHtml(
      (await fixtureHtml('simple')).replace(
        '</body>',
        '<div id="challenge">Verify you are human</div></body>',
      ),
    );
    const executor = new BrowserApplicationExecutor({
      documents: fixture.storage,
      fixtureOrigin: fixture.origin,
      sessions: fixture.sessions,
    });
    try {
      const paused = await executor.execute(fixture.input);
      await fixture
        .getSession()!
        .page.locator('#challenge')
        .evaluate((e) => e.remove());
      const resumed = await executor.execute({
        ...fixture.input,
        previousResult: paused,
      });
      expect(resumed.status, JSON.stringify(resumed)).toBe('SUBMITTED');
      expect(resumed.checkpoint!.reviewRequirement!.id).toBe(
        paused.checkpoint!.reviewRequirement!.id,
      );
      expect(resumed.checkpoint!.reviewRequirement!.status).toBe('RESOLVED');
      expect(resumed.checkpoint!.reviewRequirement!.resolution).toBe(
        'TRUSTED_CONTROL_REMOVAL',
      );
      expect(fixture.submissions).toHaveLength(1);
    } finally {
      await executor.close();
      await fixture.close();
    }
  }, 30000);

  it('H3 rejects a challenge introduced by the last dispatch authorization await before any POST', async () => {
    const fixture = await executionFixture();
    const executor = new BrowserApplicationExecutor({
      documents: fixture.storage,
      fixtureOrigin: fixture.origin,
      sessions: fixture.sessions,
    });
    let fences = 0;
    try {
      const result = await executor.execute(fixture.input, {
        persist: async () => {},
        authorizeDispatch: async () => {
          fences++;
          await fixture.getSession()!.page.evaluate(() => {
            const challenge = document.createElement('div');
            challenge.textContent = 'Verify you are human';
            document.body.append(challenge);
          });
        },
      });
      expect(fences).toBe(1);
      expect(result.status).toBe('SUBMISSION_UNKNOWN');
      expect(result.mutations!.at(-1)!.outcome).toBe('REJECTED');
      expect(fixture.submissions).toHaveLength(0);
      expect(result.checkpoint!.resumable).toBe(false);
    } finally {
      await executor.close();
      await fixture.close();
    }
  }, 30000);
});

describe('Phase 4.1 adversarial production boundaries', () => {
  it.each(['verification-gate', 'mfa', 'cf-challenge'])(
    'H3 blocks hidden %s controls independently of bounded excerpts',
    async (marker) => {
      const fixture = await executionFixture();
      fixture.setHtml(
        (await fixtureHtml('simple')).replace(
          '</body>',
          `<div>${'ordinary content '.repeat(2000)}</div><div id="${marker}" hidden>Security control</div></body>`,
        ),
      );
      const executor = new BrowserApplicationExecutor({
        documents: fixture.storage,
        fixtureOrigin: fixture.origin,
      });
      try {
        const result = await executor.execute(fixture.input);
        expect(result.status).toBe('PAUSED_HUMAN_REQUIRED');
        expect(result.error).toBe(
          marker === 'cf-challenge' ? 'CAPTCHA' : 'AUTHENTICATION_REQUIRED',
        );
        expect(fixture.submissions).toHaveLength(0);
      } finally {
        await executor.close();
        await fixture.close();
      }
    },
    30000,
  );
  it('C2 refuses authority for another execution identity or before SUBMITTING', async () => {
    const fixture = await executionFixture();
    try {
      const policy = new ExecutionNetworkPolicy(fixture.input, fixture.policy);
      const contract = bindContract(
        fixture.input,
        'step',
        'FINAL_SUBMIT',
        `${fixture.origin}/submit`,
        'POST',
        [],
      );
      for (const change of [
        { applicationId: 'another' },
        { executionId: 'another' },
        { userId: 'another' },
        { runId: 'another' },
        { generation: 2 },
      ])
        expect(() =>
          policy.allowMutation(
            { ...contract, ...change },
            'SUBMITTING',
            async () => {},
            async () => {},
          ),
        ).toThrow('Mutation does not belong to this dispatch');
      expect(() =>
        policy.allowMutation(
          contract,
          'RUNNING',
          async () => {},
          async () => {},
        ),
      ).toThrow('Final authority requires the durable submission barrier');
      policy.allowMutation(
        contract,
        'SUBMITTING',
        async () => {},
        async () => {},
      );
      policy.closeMutation();
      expect(() =>
        policy.allowMutation(
          contract,
          'SUBMITTING',
          async () => {},
          async () => {},
        ),
      ).toThrow('Final authority is single-use');
      expect(fixture.submissions).toHaveLength(0);
    } finally {
      await fixture.close();
    }
  }, 30000);
  it('H3 refuses a challenge concealed in a closed shadow root on a native element', async () => {
    const fixture = await executionFixture();
    fixture.setHtml(
      (await fixtureHtml('simple')).replace(
        '<script>',
        `<script>const host = document.createElement('div'); document.body.append(host); host.attachShadow({mode:'closed'}).innerHTML = '<div>Verify ' + 'you are human</div>';`,
      ),
    );
    const executor = new BrowserApplicationExecutor({
      documents: fixture.storage,
      fixtureOrigin: fixture.origin,
    });
    try {
      const result = await executor.execute(fixture.input);
      expect(result.status).toBe('PAUSED_HUMAN_REQUIRED');
      expect(result.error).toBe('SECURITY_INSPECTION_INCOMPLETE');
      expect(fixture.submissions).toHaveLength(0);
    } finally {
      await executor.close();
      await fixture.close();
    }
  }, 30000);
  it('C1 authorizes a distinct Next request contract and resumes without repeating it', async () => {
    const fixture = await executionFixture('multi-step');
    fixture.input.inspection.executionFlow!.pages[0]!.nextRequest = {
      destination: `${fixture.origin}/next`,
      method: 'POST',
      discriminator: { name: 'action', value: 'next', finalValue: 'submit' },
    };
    fixture.setHtml(
      (await fixtureHtml('multi-step'))
        .replace(
          "document.getElementById('next').addEventListener('click', () => {",
          "document.getElementById('next').addEventListener('click', async () => { const payload = new FormData(); payload.set('first', document.getElementById('first').value); payload.set('email', document.getElementById('email').value); payload.set('action', 'next'); await fetch('/next', {method: 'POST', body: payload});",
        )
        .replace(
          "document.getElementById('documents').hidden = false;",
          "document.getElementById('documents').hidden = false; const challenge = document.createElement('div'); challenge.id = 'challenge'; challenge.textContent = 'Verify ' + 'you are human'; document.body.append(challenge);",
        ),
    );
    const executor = new BrowserApplicationExecutor({
      documents: fixture.storage,
      fixtureOrigin: fixture.origin,
      sessions: fixture.sessions,
    });
    try {
      const paused = await executor.execute(fixture.input);
      expect(paused.status, JSON.stringify(paused)).toBe(
        'PAUSED_HUMAN_REQUIRED',
      );
      expect(fixture.nextMutations).toHaveLength(1);
      expect(fixture.submissions).toHaveLength(0);
      expect(paused.mutations?.[0]?.action).toBe('NEXT');
      expect(paused.mutations?.[0]?.outcome).toBe('FORWARDED');
      await fixture
        .getSession()!
        .page.locator('#challenge')
        .evaluate((e) => e.remove());
      const resumed = await executor.execute({
        ...fixture.input,
        previousResult: paused,
      });
      expect(resumed.status, JSON.stringify(resumed)).toBe('SUBMITTED');
      expect(fixture.nextMutations).toHaveLength(1);
      expect(fixture.submissions).toHaveLength(1);
      expect(resumed.mutations?.map((m) => m.action)).toEqual([
        'NEXT',
        'FINAL_SUBMIT',
      ]);
    } finally {
      await executor.close();
      await fixture.close();
    }
  }, 30000);

  it('C2 permits an explicitly approved rotating CSRF field from the inspected form', async () => {
    const html = (await fixtureHtml('simple')).replace(
      '</form>',
      '<input type="hidden" name="csrfToken" value="inspected_token_123456789"></form>',
    );
    const fixture = await executionFixture('simple', html);
    fixture.input.inspection.executionFlow!.pages[0]!.dynamicFields = [
      { name: 'csrfToken', purpose: 'CSRF', origin: 'INSPECTED_FORM_HIDDEN' },
    ];
    const executor = new BrowserApplicationExecutor({
      documents: fixture.storage,
      fixtureOrigin: fixture.origin,
      sessions: fixture.sessions,
    });
    try {
      const result = await executor.execute(fixture.input, {
        persist: async (state) => {
          if (state.steps.at(-1)?.type === 'SUBMIT' && !state.mutations?.length)
            await fixture
              .getSession()!
              .page.locator('[name=csrfToken]')
              .evaluate((e) => {
                (e as HTMLInputElement).value = 'rotated_token_987654321';
              });
        },
      });
      expect(result.status, JSON.stringify(result)).toBe('SUBMITTED');
      expect(fixture.submissions).toHaveLength(1);
      expect(fixture.submissions[0]!.toString()).toContain(
        'rotated_token_987654321',
      );
      expect(JSON.stringify(result)).not.toContain('rotated_token_987654321');
    } finally {
      await executor.close();
      await fixture.close();
    }
  }, 30000);

  it('M3 refuses resume on another executor without creating a replacement session', async () => {
    const fixture = await executionFixture();
    fixture.setHtml(await fixtureHtml('captcha'));
    const original = new BrowserApplicationExecutor({
      documents: fixture.storage,
      fixtureOrigin: fixture.origin,
    });
    let opened = 0;
    const other = new BrowserApplicationExecutor({
      documents: fixture.storage,
      fixtureOrigin: fixture.origin,
      sessions: (policy) => {
        opened++;
        return fixture.sessions(policy);
      },
    });
    try {
      const paused = await original.execute(fixture.input);
      expect(paused.status).toBe('PAUSED_HUMAN_REQUIRED');
      const resumed = await other.execute({
        ...fixture.input,
        previousResult: paused,
      });
      expect(resumed.status).toBe('BLOCKED');
      expect(resumed.error).toBe('SESSION_EXPIRED_OR_CHANGED');
      expect(opened).toBe(0);
      expect(fixture.submissions).toHaveLength(0);
    } finally {
      await original.close();
      await other.close();
      await fixture.close();
    }
  }, 30000);
  it.each([false, true])(
    'C1 denies a Next POST to the final endpoint, including pause/resume=%s',
    async (pause) => {
      const fixture = await executionFixture('multi-step');
      fixture.setHtml(
        (await fixtureHtml('multi-step')).replace(
          "document.getElementById('documents').hidden = false;",
          `document.getElementById('documents').hidden = false; fetch('/submit', { method: 'POST', body: new FormData(document.querySelector('form')) }).catch(() => {}); ${pause ? "const challenge = document.createElement('div'); challenge.id = 'challenge'; challenge.textContent = 'Verify ' + 'you are human'; document.body.append(challenge);" : ''}`,
        ),
      );
      const executor = new BrowserApplicationExecutor({
        documents: fixture.storage,
        fixtureOrigin: fixture.origin,
        sessions: fixture.sessions,
      });
      try {
        const result = await executor.execute(fixture.input);
        expect(result.status).not.toBe('SUBMITTED');
        expect(result.steps.some((s) => s.type === 'NAVIGATE_NEXT')).toBe(true);
        expect(result.checkpoint?.resumable).toBe(false);
        expect(fixture.submissions).toHaveLength(0);
        const resumed = await executor.execute({
          ...fixture.input,
          previousResult: result,
        });
        expect(resumed.status).toBe('BLOCKED');
        expect(fixture.submissions).toHaveLength(0);
      } finally {
        await executor.close();
        await fixture.close();
      }
    },
    30000,
  );

  it('C1 pauses before an explicitly mutating Next with overlapping final authority', async () => {
    const fixture = await executionFixture('multi-step');
    fixture.input.inspection.executionFlow!.pages[0]!.nextRequest = {
      destination: `${fixture.origin}/submit`,
      method: 'POST',
      discriminator: { name: 'action', value: 'next', finalValue: 'submit' },
    };
    const executor = new BrowserApplicationExecutor({
      documents: fixture.storage,
      fixtureOrigin: fixture.origin,
      sessions: fixture.sessions,
    });
    try {
      const paused = await executor.execute(fixture.input);
      expect(paused.status).toBe('PAUSED_HUMAN_REQUIRED');
      expect(paused.error).toBe('AMBIGUOUS_NEXT_MUTATION');
      expect(fixture.submissions).toHaveLength(0);
      const resumed = await executor.execute({
        ...fixture.input,
        previousResult: paused,
      });
      expect(resumed.status).toBe('PAUSED_HUMAN_REQUIRED');
      expect(fixture.submissions).toHaveLength(0);
    } finally {
      await executor.close();
      await fixture.close();
    }
  }, 30000);

  it('C1 generic inspection refuses to classify Continue as final Submit', async () => {
    const fixture = await executionFixture();
    fixture.setHtml(
      (await fixtureHtml('simple')).replace(
        'Submit application</button>',
        'Continue</button>',
      ),
    );
    const executor = new BrowserApplicationExecutor({
      documents: fixture.storage,
      fixtureOrigin: fixture.origin,
    });
    try {
      const inspected = await new ApplicationInspector(
        new BrowserSessionManager(true, fixture.policy, true),
      ).inspect(fixture.input.plan, 'plan', 'inspection');
      expect(inspected.schema?.executionFlow).toBeUndefined();
      fixture.input.preparedApplication.preparedAt = new Date().toISOString();
      const result = await executor.execute({
        ...fixture.input,
        inspection: inspected.schema!,
      });
      expect(result.status).toBe('PAUSED_HUMAN_REQUIRED');
      expect(result.error).toBe('EXPLICIT_FLOW_REQUIRED');
      expect(fixture.submissions).toHaveLength(0);
    } finally {
      await executor.close();
      await fixture.close();
    }
  }, 30000);

  it.each([
    [
      'changed answer',
      "payload.set('first', 'Mallory');",
      'MUTATION_VALUE_MISMATCH',
    ],
    [
      'external job substitution',
      "payload.set('jobId', 'OTHER_JOB_B');",
      'UNEXPECTED_MUTATION_FIELD',
    ],
    [
      'unexpected hidden field',
      "payload.set('hiddenRouting', 'unapproved');",
      'UNEXPECTED_MUTATION_FIELD',
    ],
    [
      'missing required field',
      "payload.delete('first');",
      'MISSING_MUTATION_FIELD',
    ],
    [
      'duplicate approved field',
      "payload.append('first', 'Ada');",
      'UNEXPECTED_MUTATION_FIELD',
    ],
  ])(
    'C2 rejects %s in serialized payload before network dispatch',
    async (_name, tampering, error) => {
      const fixture = await executionFixture();
      fixture.setHtml(tamperPayload(await fixtureHtml('simple'), tampering!));
      const executor = new BrowserApplicationExecutor({
        documents: fixture.storage,
        fixtureOrigin: fixture.origin,
        receiptTimeoutMs: 300,
      });
      const progress: ExecutionResult[] = [];
      try {
        const result = await executor.execute(fixture.input, {
          persist: async (r) => {
            progress.push(structuredClone(r));
          },
        });
        expect(result.status).toBe('SUBMISSION_UNKNOWN');
        expect(fixture.submissions).toHaveLength(0);
        expect(result.mutations).toHaveLength(1);
        expect(result.mutations![0]!.outcome).toBe('REJECTED');
        expect(result.steps.some((s) => s.error === error)).toBe(true);
        expect(progress.find((r) => r.mutations?.length)?.status).toBe(
          'SUBMITTING',
        );
        expect(JSON.stringify(result)).not.toContain('Mallory');
        expect(JSON.stringify(result)).not.toContain('ada@example.com');
      } finally {
        await executor.close();
        await fixture.close();
      }
    },
    30000,
  );

  it('C2 binds an inspected hidden external job ID and rejects its submit-time replacement', async () => {
    const html = (await fixtureHtml('simple'))
      .replace(
        '<form action=',
        '<input type="hidden" name="unrelated" disabled><form action=',
      )
      .replace(
        '</form>',
        '<input type="hidden" name="jobId" value="JOB_A"></form>',
      );
    const fixture = await executionFixture('simple', html);
    fixture.setHtml(
      tamperPayload(html, "payload.set('jobId', 'OTHER_JOB_B');"),
    );
    const executor = new BrowserApplicationExecutor({
      documents: fixture.storage,
      fixtureOrigin: fixture.origin,
      receiptTimeoutMs: 300,
    });
    try {
      expect(fixture.input.inspection.forms[0]!.hiddenFields).toEqual([
        { name: 'jobId', valueDigest: digest('JOB_A') },
      ]);
      const result = await executor.execute(fixture.input);
      expect(result.status).toBe('SUBMISSION_UNKNOWN');
      expect(result.mutations?.[0]?.outcome).toBe('REJECTED');
      expect(
        result.steps.some((s) => s.error === 'MUTATION_VALUE_MISMATCH'),
      ).toBe(true);
      expect(fixture.submissions).toHaveLength(0);
    } finally {
      await executor.close();
      await fixture.close();
    }
  }, 30000);

  it('H1 validates the live field after persistence and never fills a password replacement', async () => {
    const fixture = await executionFixture();
    const executor = new BrowserApplicationExecutor({
      documents: fixture.storage,
      fixtureOrigin: fixture.origin,
      sessions: fixture.sessions,
    });
    let replacementValue: string | undefined;
    let replaced = false;
    try {
      const result = await executor.execute(fixture.input, {
        persist: async (state) => {
          const latest = state.steps.at(-1);
          if (
            !replaced &&
            latest?.type === 'FILL_FIELD' &&
            latest.status === 'RUNNING'
          ) {
            replaced = true;
            const session = fixture.getSession()!;
            await session.page.locator('#first').evaluate((e) => {
              e.outerHTML =
                '<input id="first" name="salary" type="password" required>';
            });
            const close = session.close;
            session.close = async () => {
              replacementValue = await session.page
                .locator('#first')
                .inputValue();
              await close();
            };
          }
        },
      });
      expect(replaced).toBe(true);
      expect(result.status).toBe('BLOCKED');
      expect(result.error).toBe('STALE_DOM_FIELD');
      expect(replacementValue).toBe('');
      expect(fixture.submissions).toHaveLength(0);
    } finally {
      await executor.close();
      await fixture.close();
    }
  }, 30000);

  it.each(['before execution', 'after persistence'])(
    'H2 rejects SELECT value substitution %s',
    async (timing) => {
      const fixture = await executionFixture('multi-field');
      if (timing === 'before execution')
        fixture.setHtml(
          (await fixtureHtml('multi-field')).replace(
            'value="IN"',
            'value="UNAPPROVED_ROUTING_VALUE"',
          ),
        );
      const executor = new BrowserApplicationExecutor({
        documents: fixture.storage,
        fixtureOrigin: fixture.origin,
        sessions: fixture.sessions,
      });
      try {
        const result = await executor.execute(fixture.input, {
          persist: async (state) => {
            const latest = state.steps.at(-1);
            if (
              timing === 'after persistence' &&
              latest?.type === 'SELECT_OPTION' &&
              latest.status === 'RUNNING'
            )
              await fixture
                .getSession()!
                .page.locator('#country option[value="IN"]')
                .evaluate((e) => {
                  (e as HTMLOptionElement).value = 'UNAPPROVED_ROUTING_VALUE';
                });
          },
        });
        expect(result.status).toBe('BLOCKED');
        expect(result.error).toBe('STALE_DOM_FIELD');
        expect(fixture.submissions).toHaveLength(0);
      } finally {
        await executor.close();
        await fixture.close();
      }
    },
    30000,
  );

  it('H3 keeps an unresolved paused CAPTCHA sticky outside all extraction bounds', async () => {
    const fixture = await executionFixture();
    fixture.setHtml(
      (await fixtureHtml('simple')).replace(
        '</body>',
        '<div id="challenge">Verify you are human</div></body>',
      ),
    );
    const executor = new BrowserApplicationExecutor({
      documents: fixture.storage,
      fixtureOrigin: fixture.origin,
      sessions: fixture.sessions,
    });
    try {
      const paused = await executor.execute(fixture.input);
      expect(paused.status).toBe('PAUSED_HUMAN_REQUIRED');
      expect(paused.checkpoint?.reviewRequirement?.reason).toBe('CAPTCHA');
      await fixture.getSession()!.page.evaluate(() => {
        const challenge = document.getElementById('challenge')!;
        const filler = document.createElement('div');
        filler.textContent = 'safe text '.repeat(10000);
        document.body.append(filler);
        challenge.hidden = true;
        document.body.append(challenge);
      });
      const resumed = await executor.execute({
        ...fixture.input,
        previousResult: paused,
      });
      expect(resumed.status).toBe('PAUSED_HUMAN_REQUIRED');
      expect(resumed.checkpoint?.reviewRequirement?.reason).toBe('CAPTCHA');
      expect(
        await fixture.getSession()!.page.locator('#challenge').count(),
      ).toBe(1);
      expect(fixture.submissions).toHaveLength(0);
    } finally {
      await executor.close();
      await fixture.close();
    }
  }, 30000);

  it('H3 blocks unknown security regions instead of treating inspection as clear', async () => {
    const fixture = await executionFixture();
    fixture.setHtml(
      (await fixtureHtml('simple')).replace(
        '</body>',
        '<security-widget></security-widget></body>',
      ),
    );
    const executor = new BrowserApplicationExecutor({
      documents: fixture.storage,
      fixtureOrigin: fixture.origin,
    });
    try {
      const result = await executor.execute(fixture.input);
      expect(result.status).toBe('PAUSED_HUMAN_REQUIRED');
      expect(result.error).toBe('SECURITY_INSPECTION_INCOMPLETE');
      expect(fixture.submissions).toHaveLength(0);
    } finally {
      await executor.close();
      await fixture.close();
    }
  }, 30000);

  it('H4 rejects change-handler replacement with the same filename, MIME and size', async () => {
    const fixture = await executionFixture();
    fixture.setHtml(
      (await fixtureHtml('simple')).replace(
        '<script>',
        `<script>document.getElementById('resume').addEventListener('change', event => { const transfer = new DataTransfer(); transfer.items.add(new File([new Uint8Array(${fixture.pdf.length}).fill(65)], 'resume.pdf', {type:'application/pdf'})); event.target.files = transfer.files; });`,
      ),
    );
    const executor = new BrowserApplicationExecutor({
      documents: fixture.storage,
      fixtureOrigin: fixture.origin,
    });
    try {
      const result = await executor.execute(fixture.input);
      expect(result.status).toBe('BLOCKED');
      expect(result.error).toBe('DOCUMENT_CONTENT_MISMATCH');
      expect(fixture.submissions).toHaveLength(0);
    } finally {
      await executor.close();
      await fixture.close();
    }
  }, 30000);

  it('H4 rejects document replacement in serialized FormData after all DOM validation', async () => {
    const fixture = await executionFixture();
    fixture.setHtml(
      tamperPayload(
        await fixtureHtml('simple'),
        `payload.set('resume', new File([new Uint8Array(${fixture.pdf.length}).fill(65)], 'resume.pdf', {type:'application/pdf'}));`,
      ),
    );
    const executor = new BrowserApplicationExecutor({
      documents: fixture.storage,
      fixtureOrigin: fixture.origin,
      receiptTimeoutMs: 300,
    });
    try {
      const result = await executor.execute(fixture.input);
      expect(result.status).toBe('SUBMISSION_UNKNOWN');
      expect(
        result.steps.some((s) => s.error === 'MUTATION_DOCUMENT_MISMATCH'),
      ).toBe(true);
      expect(result.mutations?.[0]?.outcome).toBe('REJECTED');
      expect(fixture.submissions).toHaveLength(0);
    } finally {
      await executor.close();
      await fixture.close();
    }
  }, 30000);

  it('M1 stops dispatch when its transport-time freshness authorization fails', async () => {
    const fixture = await executionFixture();
    const executor = new BrowserApplicationExecutor({
      documents: fixture.storage,
      fixtureOrigin: fixture.origin,
      receiptTimeoutMs: 300,
    });
    let calls = 0;
    try {
      const result = await executor.execute(fixture.input, {
        persist: async () => {},
        authorizeDispatch: async () => {
          calls++;
          throw new Error('Preparation changed after permit');
        },
      });
      expect(calls).toBe(1);
      expect(result.status).toBe('SUBMISSION_UNKNOWN');
      expect(fixture.submissions).toHaveLength(0);
    } finally {
      await executor.close();
      await fixture.close();
    }
  }, 30000);

  it('M2 rejects a same-size valid PDF replacement using the selected document digest', async () => {
    const fixture = await executionFixture();
    try {
      const replacement = Buffer.from(fixture.pdf);
      replacement[replacement.length - 1] =
        replacement[replacement.length - 1] === 65 ? 66 : 65;
      await writeFile(join(fixture.directory, 'resume.pdf'), replacement);
      await expect(
        fixture.storage.resolve(fixture.document, ['.pdf']),
      ).rejects.toMatchObject({ code: 'DOCUMENT_DIGEST_MISMATCH' });
    } finally {
      await fixture.close();
    }
  }, 30000);

  it('M4 persists request authorization and dispatch evidence without private values', async () => {
    const fixture = await executionFixture();
    const executor = new BrowserApplicationExecutor({
      documents: fixture.storage,
      fixtureOrigin: fixture.origin,
    });
    const progress: ExecutionResult[] = [];
    try {
      const result = await executor.execute(fixture.input, {
        persist: async (r) => {
          progress.push(structuredClone(r));
        },
      });
      expect(result.status).toBe('SUBMITTED');
      expect(fixture.submissions).toHaveLength(1);
      const mutation = result.mutations![0]!;
      expect(mutation.action).toBe('FINAL_SUBMIT');
      expect(mutation.outcome).toBe('FORWARDED');
      expect(mutation.requestDigest).toMatch(/^[a-f0-9]{64}$/);
      expect(mutation.documentDigests).toEqual([
        fixture.document.metadata.contentDigest,
      ]);
      expect(
        progress.find((r) => r.mutations?.[0]?.outcome === 'DISPATCHING')
          ?.status,
      ).toBe('SUBMITTING');
      expect(JSON.stringify(result)).not.toContain('ada@example.com');
      expect(JSON.stringify(result)).not.toContain('%PDF');
    } finally {
      await executor.close();
      await fixture.close();
    }
  }, 30000);
});
