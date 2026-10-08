import { describe, expect, it } from 'vitest';
import { writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import {
  ExecutionInputSchema,
  type ExecutionInput,
  type ExecutionResult,
} from '@careerlift/domain';
import { BrowserApplicationExecutor } from './executor.js';
import { ApplicationInspector } from './inspector.js';
import { BrowserSessionManager } from './session.js';
import { ExecutionNetworkPolicy } from './execution-policy.js';
import { DestinationPolicy } from './policy.js';
import { LocalDocumentStorage } from './document-storage.js';
import {
  executionFixture,
  fixtureHtml,
} from '../../../tests/support/execution-fixture.js';

describe('deterministic browser execution against a real local HTTPS server', () => {
  it('refuses to give Phase 2 inspection an execution network policy', async () => {
    const fixture = await executionFixture();
    try {
      const manager = new BrowserSessionManager(
        true,
        new ExecutionNetworkPolicy(fixture.input, fixture.policy),
        true,
      );
      const result = await new ApplicationInspector(manager).inspect(
        fixture.input.plan,
        'plan',
        'inspection',
      );
      expect(result).toEqual({
        status: 'FAILED',
        errorCode: 'READ_ONLY_POLICY_REQUIRED',
      });
      expect(fixture.submissions).toHaveLength(0);
    } finally {
      await fixture.close();
    }
  }, 30000);
  it.each(['simple', 'multi-field', 'multi-step'])(
    'fills and uploads %s, submits once, and verifies a fixture receipt',
    async (name) => {
      const fixture = await executionFixture(name);
      const executor = new BrowserApplicationExecutor({
        documents: fixture.storage,
        fixtureOrigin: fixture.origin,
      });
      const progress: ExecutionResult[] = [];
      try {
        const result = await executor.execute(fixture.input, {
          persist: async (value) => {
            progress.push(structuredClone(value));
          },
        });
        expect(result.status, JSON.stringify(result)).toBe('SUBMITTED');
        expect(fixture.submissions).toHaveLength(1);
        const posted = fixture.submissions[0]!.toString();
        expect(posted).toContain('Ada');
        expect(posted).toContain('ada@example.com');
        expect(posted).toContain('%PDF-1.7');
        expect(result.steps.every((s) => s.status === 'COMPLETED')).toBe(true);
        expect(result.steps.some((s) => s.type === 'UPLOAD_DOCUMENT')).toBe(
          true,
        );
        expect(
          progress
            .find((p) => p.status === 'SUBMITTING')
            ?.steps.some(
              (s) =>
                s.type === 'PRE_SUBMIT_VALIDATION' && s.status === 'COMPLETED',
            ),
        ).toBe(true);
        if (name === 'multi-field') {
          for (const value of [
            '+919876543210',
            'https://example.com/portfolio',
            '2025-06-01',
            'Built deterministic services.',
            'IN',
            'remote',
          ])
            expect(posted).toContain(value);
          expect(posted).not.toContain('name="optional"');
        }
        if (name === 'multi-step')
          expect(
            result.steps.filter((s) => s.type === 'NAVIGATE_NEXT'),
          ).toHaveLength(1);
        // Execution records contain references and codes, never prepared private values or file contents.
        expect(JSON.stringify(result)).not.toContain('ada@example.com');
        expect(JSON.stringify(result)).not.toContain('%PDF');
      } finally {
        await executor.close();
        await fixture.close();
      }
    },
    30000,
  );
  it('dry run resolves and validates fields without firing mutations, upload, or submit', async () => {
    const fixture = await executionFixture('multi-field');
    const executor = new BrowserApplicationExecutor({
      documents: fixture.storage,
      fixtureOrigin: fixture.origin,
      sessions: fixture.sessions,
    });
    let values: string[] = [];
    try {
      const sessions = fixture.sessions;
      const observed = new BrowserApplicationExecutor({
        documents: fixture.storage,
        fixtureOrigin: fixture.origin,
        sessions: (policy) => {
          const manager = sessions(policy);
          const create = manager.create.bind(manager);
          manager.create = async () => {
            const session = await create();
            const close = session.close;
            session.close = async () => {
              values = await session.page
                .locator(
                  'input:not([type=file]):not([type=radio]):not([type=checkbox]),textarea',
                )
                .evaluateAll((elements) =>
                  elements.map((e) => (e as HTMLInputElement).value),
                );
              await close();
            };
            return session;
          };
          return manager;
        },
      });
      const result = await observed.execute({
        ...fixture.input,
        mode: 'DRY_RUN',
      });
      expect(result.status, JSON.stringify(result)).toBe('DRY_RUN_COMPLETED');
      expect(values.every((v) => v === '')).toBe(true);
      expect(fixture.submissions).toHaveLength(0);
      expect(
        result.steps
          .filter((s) =>
            [
              'FILL_FIELD',
              'UPLOAD_DOCUMENT',
              'SUBMIT',
              'CHECK_OPTION',
              'SELECT_OPTION',
            ].includes(s.type),
          )
          .every((s) => s.status === 'SIMULATED'),
      ).toBe(true);
      await observed.close();
    } finally {
      await executor.close();
      await fixture.close();
    }
  }, 30000);
  it.each(['failure', 'unknown'] as const)(
    'handles %s outcome without claiming submission',
    async (outcome) => {
      const fixture = await executionFixture();
      fixture.setOutcome(outcome);
      const executor = new BrowserApplicationExecutor({
        documents: fixture.storage,
        fixtureOrigin: fixture.origin,
        receiptTimeoutMs: 700,
      });
      try {
        const result = await executor.execute(fixture.input);
        expect(result.status, JSON.stringify(result)).toBe(
          outcome === 'failure' ? 'FAILED' : 'SUBMISSION_UNKNOWN',
        );
        expect(result.confirmation).toBeUndefined();
        expect(result.checkpoint?.resumable).toBe(false);
        expect(fixture.submissions).toHaveLength(1);
        const resumed = await executor.execute({
          ...fixture.input,
          previousResult: result,
        });
        expect(resumed.status).toBe('BLOCKED');
        expect(fixture.submissions).toHaveLength(1);
      } finally {
        await executor.close();
        await fixture.close();
      }
    },
    30000,
  );
  it.each(['captcha', 'authentication'])(
    'pauses on %s and resumes the original session at its safe checkpoint',
    async (name) => {
      const fixture = await executionFixture();
      fixture.setHtml(await fixtureHtml(name));
      const executor = new BrowserApplicationExecutor({
        documents: fixture.storage,
        fixtureOrigin: fixture.origin,
        sessions: fixture.sessions,
      });
      try {
        const result = await executor.execute(fixture.input);
        expect(result.status).toBe('PAUSED_HUMAN_REQUIRED');
        expect(result.humanReviewItems[0]?.reason).toBe(
          name === 'captcha' ? 'CAPTCHA' : 'AUTHENTICATION_REQUIRED',
        );
        expect(fixture.submissions).toHaveLength(0);
        fixture.setHtml(await fixtureHtml('simple'));
        // Test-only human action. The executor contains no authentication or challenge resolution code.
        await fixture
          .getSession()!
          .page.reload({ waitUntil: 'domcontentloaded' });
        const resumed = await executor.execute({
          ...fixture.input,
          previousResult: result,
        });
        expect(resumed.status, JSON.stringify(resumed)).toBe('SUBMITTED');
        expect(resumed.steps.filter((s) => s.type === 'NAVIGATE')).toHaveLength(
          1,
        );
        expect(fixture.submissions).toHaveLength(1);
      } finally {
        await executor.close();
        await fixture.close();
      }
    },
    30000,
  );
  it('blocks a lost browser session instead of replaying the form', async () => {
    const fixture = await executionFixture();
    fixture.setHtml(await fixtureHtml('captcha'));
    const executor = new BrowserApplicationExecutor({
      documents: fixture.storage,
      fixtureOrigin: fixture.origin,
    });
    try {
      const paused = await executor.execute(fixture.input);
      await executor.close();
      const result = await executor.execute({
        ...fixture.input,
        previousResult: paused,
      });
      expect(result.status).toBe('BLOCKED');
      expect(result.error).toBe('SESSION_EXPIRED_OR_CHANGED');
      expect(fixture.submissions).toHaveLength(0);
    } finally {
      await executor.close();
      await fixture.close();
    }
  }, 30000);
  it('resumes after a completed page without refilling fields, navigating again, or repeating upload', async () => {
    const fixture = await executionFixture('multi-step');
    const html = await fixtureHtml('multi-step');
    fixture.setHtml(
      html.replace(
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
      expect(paused.status).toBe('PAUSED_HUMAN_REQUIRED');
      expect(paused.checkpoint?.pageIndex).toBe(1);
      expect(paused.checkpoint?.appliedFieldIds).toHaveLength(2);
      expect(fixture.submissions).toHaveLength(0);
      await fixture
        .getSession()!
        .page.locator('#challenge')
        .evaluate((element) => element.remove());
      const result = await executor.execute({
        ...fixture.input,
        previousResult: paused,
      });
      expect(result.status, JSON.stringify(result)).toBe('SUBMITTED');
      expect(result.steps.filter((s) => s.type === 'FILL_FIELD')).toHaveLength(
        2,
      );
      expect(
        result.steps.filter((s) => s.type === 'NAVIGATE_NEXT'),
      ).toHaveLength(1);
      expect(
        result.steps.filter((s) => s.type === 'UPLOAD_DOCUMENT'),
      ).toHaveLength(1);
      expect(fixture.submissions).toHaveLength(1);
    } finally {
      await executor.close();
      await fixture.close();
    }
  }, 30000);
  it('revalidates fields from earlier pages when they remain in the DOM', async () => {
    const fixture = await executionFixture('multi-step');
    fixture.setHtml(
      (await fixtureHtml('multi-step')).replace(
        "document.getElementById('documents').hidden = false;",
        "document.getElementById('documents').hidden = false; document.getElementById('first').value = 'altered';",
      ),
    );
    const executor = new BrowserApplicationExecutor({
      documents: fixture.storage,
      fixtureOrigin: fixture.origin,
    });
    try {
      const result = await executor.execute(fixture.input);
      expect(result.status).toBe('BLOCKED');
      expect(result.error).toBe('PRE_SUBMIT_VALUE_MISMATCH');
      expect(fixture.submissions).toHaveLength(0);
    } finally {
      await executor.close();
      await fixture.close();
    }
  }, 30000);
  it.each(['name', 'label'])(
    'uses deterministic %s identity when DOM ID metadata is unavailable',
    async (fallback) => {
      const fixture = await executionFixture();
      const field = fixture.input.inspection.fields.find(
        (f) => f.domId === 'first',
      )!;
      delete field.domId;
      if (fallback === 'label') delete field.name;
      const executor = new BrowserApplicationExecutor({
        documents: fixture.storage,
        fixtureOrigin: fixture.origin,
      });
      try {
        expect((await executor.execute(fixture.input)).status).toBe(
          'SUBMITTED',
        );
        expect(fixture.submissions).toHaveLength(1);
      } finally {
        await executor.close();
        await fixture.close();
      }
    },
    30000,
  );
  it.each(['POST', 'GET'])(
    'blocks unsolicited %s triggered by field filling before any request is forwarded',
    async (method) => {
      const fixture = await executionFixture();
      const html = await fixtureHtml('simple');
      const request =
        method === 'POST'
          ? "fetch('/submit', { method: 'POST', body: 'unapproved' })"
          : "fetch('/collect?answer=unapproved')";
      fixture.setHtml(
        html.replace(
          '<script>',
          `<script>document.getElementById('first').addEventListener('input', () => { ${request}.catch(() => {}); });`,
        ),
      );
      const executor = new BrowserApplicationExecutor({
        documents: fixture.storage,
        fixtureOrigin: fixture.origin,
      });
      try {
        const result = await executor.execute(fixture.input);
        expect(result.status, JSON.stringify(result)).toBe('BLOCKED');
        expect(fixture.submissions).toHaveLength(0);
      } finally {
        await executor.close();
        await fixture.close();
      }
    },
    30000,
  );
  it('never clicks Submit when the durable submission barrier cannot be committed', async () => {
    const fixture = await executionFixture();
    const executor = new BrowserApplicationExecutor({
      documents: fixture.storage,
      fixtureOrigin: fixture.origin,
    });
    try {
      const result = await executor.execute(fixture.input, {
        persist: async (state) => {
          if (state.status === 'SUBMITTING')
            throw new Error('persistence unavailable');
        },
      });
      expect(result.status).toBe('SUBMISSION_UNKNOWN');
      expect(fixture.submissions).toHaveLength(0);
    } finally {
      await executor.close();
      await fixture.close();
    }
  }, 30000);
  it.each([
    [
      'stale type',
      (html: string) =>
        html.replace(
          'id="first" name="first"',
          'type="number" id="first" name="first"',
        ),
      'BLOCKED',
    ],
    [
      'changed label',
      (html: string) =>
        html.replace(/First name<\/label/, 'Salary expectation</label'),
      'BLOCKED',
    ],
    [
      'missing field',
      (html: string) =>
        html.replace(/<input id="first" name="first" required\s*\/?>/, ''),
      'PAUSED_HUMAN_REQUIRED',
    ],
    [
      'ambiguous field',
      (html: string) =>
        html.replace(
          /<input id="first" name="first" required\s*\/?>/,
          '<input id="first" name="first" required><input id="first" name="first" required>',
        ),
      'PAUSED_HUMAN_REQUIRED',
    ],
    [
      'new required field',
      (html: string) =>
        html.replace('</form>', '<input name="salary" required></form>'),
      'BLOCKED',
    ],
    [
      'unexpected submit button',
      (html: string) => html.replace('id="send"', 'id="unexpected"'),
      'PAUSED_HUMAN_REQUIRED',
    ],
    [
      'changed form action',
      (html: string) =>
        html.replace(
          'action="/submit"',
          'action="https://example.com/elsewhere"',
        ),
      'BLOCKED',
    ],
    [
      'submit override',
      (html: string) =>
        html.replace('id="send"', 'formaction="/elsewhere" id="send"'),
      'BLOCKED',
    ],
    [
      'changed file acceptance',
      (html: string) => html.replace('accept=".pdf"', 'accept=".exe"'),
      'BLOCKED',
    ],
  ] as const)(
    'stops at %s without submitting',
    async (_name, change, status) => {
      const fixture = await executionFixture();
      fixture.setHtml(change(await fixtureHtml('simple')));
      const executor = new BrowserApplicationExecutor({
        documents: fixture.storage,
        fixtureOrigin: fixture.origin,
      });
      try {
        const result = await executor.execute(fixture.input);
        expect(result.status, JSON.stringify(result)).toBe(status);
        expect(fixture.submissions).toHaveLength(0);
      } finally {
        await executor.close();
        await fixture.close();
      }
    },
    30000,
  );
  it('requires an exact SELECT option and blocks invalid mandatory DOM values', async () => {
    const fixture = await executionFixture('multi-field');
    const executor = new BrowserApplicationExecutor({
      documents: fixture.storage,
      fixtureOrigin: fixture.origin,
    });
    try {
      const country = fixture.input.preparedApplication.fields.find(
        (f) =>
          f.fieldId ===
          fixture.input.inspection.fields.find((f) => f.domId === 'country')!
            .id,
      )!;
      country.value = 'Closest country';
      const invalid = await executor.execute(fixture.input);
      expect(invalid.status).toBe('PAUSED_HUMAN_REQUIRED');
      expect(invalid.error).toBe('INVALID_OPTION');
      await executor.close();
      country.value = 'India';
      const number = fixture.input.preparedApplication.fields.find(
        (f) =>
          f.fieldId ===
          fixture.input.inspection.fields.find((f) => f.domId === 'number')!.id,
      )!;
      number.value = '-1';
      const missing = await executor.execute(fixture.input);
      expect(missing.status).toBe('BLOCKED');
      expect(missing.error).toBe('PRE_SUBMIT_VALUE_MISMATCH');
      expect(fixture.submissions).toHaveLength(0);
    } finally {
      await executor.close();
      await fixture.close();
    }
  }, 30000);
  it('enforces preflight before opening the browser', async () => {
    const fixture = await executionFixture();
    let opened = 0;
    const executor = new BrowserApplicationExecutor({
      documents: fixture.storage,
      fixtureOrigin: fixture.origin,
      sessions: (policy) => {
        opened++;
        return fixture.sessions(policy);
      },
    });
    try {
      const variants: ExecutionInput[] = [
        { ...fixture.input, applicationId: 'wrong' },
        { ...fixture.input, inspectionId: 'wrong' },
        { ...fixture.input, jobId: 'wrong' },
        { ...fixture.input, currentPreparationVersion: 2 },
        { ...fixture.input, preparationState: 'PENDING' } as never,
        {
          ...fixture.input,
          preparedApplication: {
            ...fixture.input.preparedApplication,
            overallStatus: 'HUMAN_REQUIRED',
            humanReviewItems: [
              {
                requirementId: 'salary',
                reason: 'Human answer required',
                category: 'SALARY',
              },
            ],
          },
        },
        {
          ...fixture.input,
          preparedApplication: {
            ...fixture.input.preparedApplication,
            fields: [],
          },
        },
        { ...fixture.input, mode: 'REAL_EXECUTION' },
      ];
      for (const input of variants)
        expect((await executor.execute(input)).status).toBe('BLOCKED');
      expect(opened).toBe(0);
      expect(fixture.submissions).toHaveLength(0);
      fixture.input.documents[0]!.storageRef = 'local://missing.pdf';
      expect((await executor.execute(fixture.input)).error).toBe(
        'DOCUMENT_MISSING',
      );
      expect(opened).toBe(0);
    } finally {
      await executor.close();
      await fixture.close();
    }
  }, 30000);
  it.each([
    'http://localhost/admin',
    'https://169.254.169.254/latest',
    'https://example.com/different-job',
  ])(
    'blocks redirect to %s',
    async (redirect) => {
      const fixture = await executionFixture();
      fixture.setRedirect(redirect);
      const executor = new BrowserApplicationExecutor({
        documents: fixture.storage,
        fixtureOrigin: fixture.origin,
      });
      try {
        const result = await executor.execute(fixture.input);
        expect(result.status).toBe('BLOCKED');
        expect(fixture.submissions).toHaveLength(0);
      } finally {
        await executor.close();
        await fixture.close();
      }
    },
    30000,
  );
  it('REAL_EXECUTION cannot be enabled inside automated tests', async () => {
    const fixture = await executionFixture();
    const executor = new BrowserApplicationExecutor({
      documents: fixture.storage,
      allowRealExecution: true,
    });
    try {
      const result = await executor.execute({
        ...fixture.input,
        mode: 'REAL_EXECUTION',
      });
      expect(result.error).toBe('REAL_EXECUTION_DISABLED');
    } finally {
      await fixture.close();
    }
  }, 30000);
});

describe('document storage security', () => {
  it('rejects traversal, arbitrary files, spoofed MIME, size, directories, and invalid acceptance', async () => {
    const fixture = await executionFixture();
    try {
      const document = fixture.document;
      for (const storageRef of [
        'local://../../secret.pdf',
        'C:\\secret.pdf',
        'local:///secret.pdf',
        'object://resume/file',
        'local://resume.exe',
      ])
        await expect(
          fixture.storage.resolve({ ...document, storageRef }, ['.pdf']),
        ).rejects.toMatchObject({ code: 'INVALID_DOCUMENT_REFERENCE' });
      await expect(
        fixture.storage.resolve({ ...document, mimeType: 'text/plain' }, [
          '.pdf',
        ]),
      ).rejects.toMatchObject({ code: 'DOCUMENT_MIME_INVALID' });
      await expect(
        fixture.storage.resolve({ ...document, size: 1 }, ['.pdf']),
      ).rejects.toMatchObject({ code: 'DOCUMENT_SIZE_INVALID' });
      await expect(
        new LocalDocumentStorage(fixture.directory, 1).resolve(document, [
          '.pdf',
        ]),
      ).rejects.toMatchObject({ code: 'DOCUMENT_SIZE_INVALID' });
      await expect(
        fixture.storage.resolve(document, ['.txt']),
      ).rejects.toMatchObject({ code: 'DOCUMENT_TYPE_NOT_ALLOWED' });
      await mkdir(join(fixture.directory, 'folder.pdf'));
      await expect(
        fixture.storage.resolve(
          { ...document, storageRef: 'local://folder.pdf' },
          ['.pdf'],
        ),
      ).rejects.toMatchObject({ code: 'DOCUMENT_NOT_FILE' });
      await writeFile(
        join(fixture.directory, 'resume.pdf'),
        Buffer.alloc(document.size, 65),
      );
      await expect(
        fixture.storage.resolve(document, ['.pdf']),
      ).rejects.toMatchObject({ code: 'DOCUMENT_MIME_INVALID' });
    } finally {
      await fixture.close();
    }
  }, 30000);
  it('keeps public-address and fixture capabilities separate', async () => {
    expect(() => new DestinationPolicy('https://example.com')).toThrow();
    await expect(
      new DestinationPolicy(undefined, async () => [
        '127.0.0.1',
      ]).validateAddress('https://example.com'),
    ).rejects.toMatchObject({ code: 'UNSAFE_DESTINATION' });
    expect(
      ExecutionInputSchema.safeParse({ mode: 'REAL_EXECUTION' }).success,
    ).toBe(false);
  });
});
