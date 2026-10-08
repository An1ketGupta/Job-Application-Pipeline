import { describe, expect, it, vi } from 'vitest';
import {
  GoogleFormsBrowser,
  googleFormsUploadEndpoint,
  googleFormsBackgroundRequest,
  googleFormsPickerReadEndpoint,
  validateGoogleFormsPayload,
} from './google-forms-browser.js';
import type { MutationContract } from './mutation-contract.js';
import { googleFormsFixture } from '../../../tests/support/google-forms-fixture.js';
import type { GoogleFormAnswer } from '@careerlift/domain';
const identity = {
  applicationId: 'application',
  runId: 'run',
  userId: 'owner',
  version: 1,
};
const answer = (
  id: string,
  value: string | string[] | null,
  documentId: string | null = null,
): GoogleFormAnswer => ({
  id,
  value,
  documentId,
  source: 'REVIEW',
  evidenceIds: [],
  review: null,
});
describe('Google Forms upload network policy', () => {
  it('accepts a click-time timestamp only within the submission window while still binding answers', async () => {
    const now = Date.now();
    const contract: MutationContract = {
      applicationId: 'application',
      executionId: 'run',
      userId: 'owner',
      runId: 'run',
      generation: 1,
      actionId: 'submit',
      action: 'FINAL_SUBMIT',
      destination:
        'https://docs.google.com/forms/d/e/controlled-form/formResponse',
      method: 'POST',
      externalIdentity: {
        canonicalApplicationUrl:
          'https://docs.google.com/forms/d/e/controlled-form/viewform',
        jobFields: [],
      },
      fields: [
        { name: 'entry.101', kind: 'STATIC_APPROVED_FIELD', value: 'Ada' },
        {
          name: 'submissionTimestamp',
          kind: 'STATIC_APPROVED_FIELD',
          value: '-1',
        },
      ],
    };
    const encode = (name: string, stamp: string) =>
      Buffer.from(
        new URLSearchParams({
          'entry.101': name,
          submissionTimestamp: stamp,
        }).toString(),
      );
    const window = { from: now - 1000, to: now + 15000 };
    await expect(
      validateGoogleFormsPayload(
        contract,
        encode('Ada', String(now)),
        'application/x-www-form-urlencoded',
        window,
      ),
    ).resolves.toBeUndefined();
    for (const [name, stamp] of [
      ['Unapproved', String(now)],
      ['Ada', '0'],
      ['Ada', String(now + 30000)],
    ])
      await expect(
        validateGoogleFormsPayload(
          contract,
          encode(name!, stamp!),
          'application/x-www-form-urlencoded',
          window,
        ),
      ).rejects.toMatchObject({ code: 'MUTATION_VALUE_MISMATCH' });
  });
  it('suppresses draftresponse only for the current form and only for POST', () => {
    const canonical =
      'https://docs.google.com/forms/d/e/controlled-form/viewform';
    for (const prefix of [
      '/forms/d/e',
      '/forms/u/0/d/e',
      '/forms/d',
      '/forms/u/2/d',
    ]) {
      const url = `https://docs.google.com${prefix}/controlled-form/draftresponse?draft=private`;
      expect(googleFormsBackgroundRequest(url, 'POST', canonical)).toBe(true);
      expect(googleFormsBackgroundRequest(url, 'GET', canonical)).toBe(false);
      expect(googleFormsBackgroundRequest(url, 'PUT', canonical)).toBe(false);
    }
    for (const path of [
      'other-form/draftresponse',
      'controlled-form/draftresponse/other',
      'controlled-form/formResponse',
    ])
      expect(
        googleFormsBackgroundRequest(
          `https://docs.google.com/forms/d/e/${path}`,
          'POST',
          canonical,
        ),
      ).toBe(false);
  });
  it('suppresses picker telemetry and CSP reports without granting upload or submission authority', () => {
    const canonical =
      'https://docs.google.com/forms/d/e/controlled-form/viewform';
    for (const url of [
      'https://docs.google.com/picker/logImpressions?token=private',
      'https://docs.google.com/picker/stat',
      'https://csp.withgoogle.com/csp/proto/f35e190d6c26b2ef7a230412bd3da3a8',
      'https://clients6.google.com/batch/drive/v2internal',
      'https://signaler-pa.clients6.google.com/punctual/v1/chooseServer',
    ]) {
      expect(googleFormsBackgroundRequest(url, 'POST', canonical)).toBe(true);
      expect(googleFormsBackgroundRequest(url, 'PUT', canonical)).toBe(false);
    }
    for (const url of [
      'https://docs.google.com/picker/upload',
      'https://docs.google.com/picker/stat/other',
      'https://evil.example/picker/stat',
      'https://csp.withgoogle.com/other',
      'https://clients6.google.com/upload/drive/v2/files',
      'https://clients6.google.com/batch/other',
      'https://signaler-pa.clients6.google.com/punctual/v1/other',
      'https://docs.google.com/forms/d/e/controlled-form/formResponse',
    ])
      expect(googleFormsBackgroundRequest(url, 'POST', canonical)).toBe(false);
  });
  it('allows only the observed picker account and Drive metadata read endpoints', () => {
    for (const [host, path] of [
      ['clients6.google.com', '/drive/v2internal/apps'],
      ['clients6.google.com', '/drive/v2internal/changes/startPageToken'],
      ['clients6.google.com', '/empty.js'],
      ['drivefrontend-pa.clients6.google.com', '/v1/account'],
      ['drivefrontend-pa.clients6.google.com', '/empty.js'],
    ])
      expect(googleFormsPickerReadEndpoint(host!, path!)).toBe(true);
    for (const [host, path] of [
      ['evil.example', '/v1/account'],
      ['clients6.google.com', '/drive/v2internal/files'],
      ['clients6.google.com', '/upload/drive/v2/files'],
      ['drivefrontend-pa.clients6.google.com', '/v1/account/other'],
    ])
      expect(googleFormsPickerReadEndpoint(host!, path!)).toBe(false);
  });
  it('suppresses known background writes without authorizing responses, uploads or unrelated forms', () => {
    const canonical =
      'https://docs.google.com/forms/d/e/controlled-form/viewform';
    for (const path of [
      'naLogImpressions',
      'font/getmetadata',
      'autosave',
      'draftresponse',
    ]) {
      expect(
        googleFormsBackgroundRequest(
          `https://docs.google.com/forms/u/0/d/e/controlled-form/${path}?x=1`,
          'POST',
          canonical,
        ),
      ).toBe(true);
      expect(
        googleFormsBackgroundRequest(
          `https://docs.google.com/forms/d/e/other-form/${path}`,
          'POST',
          canonical,
        ),
      ).toBe(false);
    }
    expect(
      googleFormsBackgroundRequest(
        'https://play.google.com/log?format=json',
        'POST',
        canonical,
      ),
    ).toBe(true);
    for (const url of [
      'https://docs.google.com/forms/d/e/controlled-form/formResponse',
      'https://docs.google.com/forms/fileupload',
      'https://docs.google.com/_/GoogleFormsUi/data/batchexecute',
      'https://play.google.com/other',
      'https://evil.example/log',
      'http://play.google.com/log',
    ])
      expect(googleFormsBackgroundRequest(url, 'POST', canonical)).toBe(false);
    expect(
      googleFormsBackgroundRequest(
        'https://play.google.com/log',
        'GET',
        canonical,
      ),
    ).toBe(false);
  });
  it('allows the Forms file upload endpoint used by the Drive picker', () => {
    expect(
      googleFormsUploadEndpoint(
        'clients6.google.com',
        '/upload/drive/v2internal/files',
      ),
    ).toBe(true);
    for (const path of [
      '/upload/drive/v2/files',
      '/drive/v2internal/files',
      '/upload/drive/v2internal/files/other',
    ])
      expect(googleFormsUploadEndpoint('clients6.google.com', path)).toBe(
        false,
      );
    expect(
      googleFormsUploadEndpoint('docs.google.com', '/forms/fileupload'),
    ).toBe(true);
    expect(
      googleFormsUploadEndpoint('docs.google.com', '/forms/u/0/fileupload'),
    ).toBe(true);
    expect(
      googleFormsUploadEndpoint('docs.google.com', '/forms/fileupload/other'),
    ).toBe(false);
    expect(googleFormsUploadEndpoint('evil.example', '/forms/fileupload')).toBe(
      false,
    );
  });
});
describe('Google Forms browser against controlled local HTTPS fixtures', () => {
  it('maps nested Google question metadata to separately serialized answer fields', async () => {
    const fixture = await googleFormsFixture({
      controls: `
      <section data-google-question><div data-params='%.@.[501,"Work location",null,0,[[501,null,true]]],"i1","i2",false]'>
      <h2 role="heading">Work location *</h2><input aria-label="Work location" required></div></section>
      <input type="hidden" name="entry.501">
      <section data-google-question><div data-params='%.@.[502,"Work style",null,2,[[502,null,true]]],"i3","i4",false]'>
      <h2 role="heading">Work style *</h2><div role="radiogroup"><div role="radio" data-value="Remote" aria-checked="false" tabindex="0">Remote</div></div>
      <input type="hidden" name="entry.502_sentinel"></div></section><input type="hidden" name="entry.502">
      <input type="hidden" name="hud" value="true"><input type="hidden" name="token" value="fixture-token"><input type="hidden" name="tag" value="fixture-tag">
      <script>
      document.querySelector('[aria-label="Work location"]').oninput = event => document.querySelector('[name="entry.501"]').value = event.target.value;
      document.querySelector('[role="radio"]').onclick = event => { event.target.setAttribute('aria-checked','true'); document.querySelector('[name="entry.502"]').value = 'Remote'; };
      </script>`,
    });
    const browser = await GoogleFormsBrowser.open({
      url: fixture.url,
      fixtureOrigin: fixture.origin,
      storage: fixture.storage,
      headless: true,
    });
    try {
      const inspection = await browser.inspect();
      expect(inspection.questions.map((q) => q.id)).toContain('entry.501');
      expect(inspection.questions.map((q) => q.id)).toContain('entry.502');
      await browser.fill(
        [
          answer('entry.101', 'Ada'),
          answer('entry.202', 'ada@example.com'),
          answer('entry.501', 'London'),
          answer('entry.502', 'Remote'),
        ],
        [],
      );
      const contract = await browser.prepareSubmit(identity);
      expect(fixture.submissions).toHaveLength(0);
      expect(contract.fields).toContainEqual({
        name: 'entry.501',
        kind: 'STATIC_APPROVED_FIELD',
        value: 'London',
      });
      expect(
        (
          await browser.submit(identity, {
            authorize: async () => {},
            transport: async () => {},
          })
        ).confirmed,
      ).toBe(true);
      expect(fixture.submissions).toHaveLength(1);
    } finally {
      await browser.close();
      await fixture.close();
    }
  }, 45000);
  it('rejects an attachment token changed after upload and unknown file question IDs', async () => {
    const fixture = await googleFormsFixture({
      picker: {},
      controls: '<input type="hidden" name="fuIds" value="404">',
    });
    const browser = await GoogleFormsBrowser.open({
      url: fixture.url,
      fixtureOrigin: fixture.origin,
      storage: fixture.storage,
      headless: true,
    });
    try {
      await browser.inspect();
      await browser.fill(
        [
          answer('entry.101', 'Ada'),
          answer('entry.202', 'ada@example.com'),
          answer('entry.404', null, fixture.document.id),
        ],
        [fixture.document],
      );
      await browser.prepareSubmit(identity);
      await browser.page
        .locator('[name="fuIds"]')
        .evaluate((e) => ((e as HTMLInputElement).value = '999'));
      await expect(browser.prepareSubmit(identity)).rejects.toThrow(
        'GOOGLE_FORMS_UNAPPROVED_FILE',
      );
      await browser.page
        .locator('[name="fuIds"]')
        .evaluate((e) => ((e as HTMLInputElement).value = '404'));
      await browser.page
        .locator('[name="entry.404"]')
        .evaluate((e) => ((e as HTMLInputElement).value = 'another-file-id'));
      await expect(browser.prepareSubmit(identity)).rejects.toThrow(
        'GOOGLE_FORMS_UNAPPROVED_VALUE',
      );
      expect(fixture.submissions).toHaveLength(0);
    } finally {
      await browser.close();
      await fixture.close();
    }
  }, 45000);
  it('records a blocked endpoint without query secrets or answer bodies and clears it before retry', async () => {
    const fixture = await googleFormsFixture();
    const browser = await GoogleFormsBrowser.open({
      url: fixture.url,
      fixtureOrigin: fixture.origin,
      storage: fixture.storage,
      headless: true,
    });
    try {
      await browser.page.evaluate(async () => {
        await fetch('/unapproved?token=private-secret', {
          method: 'POST',
          body: 'private-answer',
        }).catch(() => {});
      });
      expect(browser.networkFailure()).toEqual({
        code: 'GOOGLE_FORMS_UNAPPROVED_MUTATION',
        method: 'POST',
        origin: fixture.origin,
        pathname: '/unapproved',
      });
      const logged = JSON.stringify(browser.networkFailure());
      expect(logged).not.toContain('private-secret');
      expect(logged).not.toContain('private-answer');
      await browser.finishHumanInteraction();
      expect(browser.networkFailure()).toBeNull();
    } finally {
      await browser.close();
      await fixture.close();
    }
  });
  it('continues an already open picker without reopening the dialog', async () => {
    const fixture = await googleFormsFixture({ picker: { chooser: true } });
    const browser = await GoogleFormsBrowser.open({
      url: fixture.url,
      fixtureOrigin: fixture.origin,
      storage: fixture.storage,
      headless: true,
    });
    try {
      await browser.inspect();
      await browser.page.getByRole('button', { name: 'Add file' }).click();
      await browser.page
        .frameLocator('iframe')
        .getByRole('tab', {
          name: 'Upload',
          exact: true,
        })
        .waitFor({ state: 'visible' });
      await browser.fill(
        [
          answer('entry.101', 'Ada'),
          answer('entry.202', 'ada@example.com'),
          answer('entry.404', null, fixture.document.id),
        ],
        [fixture.document],
      );
      expect(await browser.page.locator('iframe').count()).toBe(0);
      expect(fixture.uploads).toHaveLength(1);
    } finally {
      await browser.close();
      await fixture.close();
    }
  }, 45000);
  it('keeps a failed picker upload unconfirmed even if another field shows the filename', async () => {
    const fixture = await googleFormsFixture({
      picker: { failure: true },
      controls: '<p>Previously uploaded resume.pdf</p>',
    });
    const browser = await GoogleFormsBrowser.open({
      url: fixture.url,
      fixtureOrigin: fixture.origin,
      storage: fixture.storage,
      headless: true,
    });
    try {
      await browser.inspect();
      const answers = [
        answer('entry.101', 'Ada'),
        answer('entry.202', 'ada@example.com'),
        answer('entry.404', null, fixture.document.id),
      ];
      await expect(browser.fill(answers, [fixture.document])).rejects.toThrow(
        'GOOGLE_FORMS_UPLOAD_NOT_CONFIRMED',
      );
      await expect(browser.validateFilled(answers)).rejects.toThrow(
        'GOOGLE_FORMS_UPLOAD_NOT_CONFIRMED',
      );
      expect(browser.alive()).toBe(true);
      expect(fixture.uploads).toHaveLength(1);
      expect(fixture.submissions).toHaveLength(0);
    } finally {
      await browser.close();
      await fixture.close();
    }
  }, 45000);
  it.each([
    { name: 'hidden input', picker: {} },
    { name: 'Browse-created input', picker: { chooser: true } },
    { name: 'automatic upload', picker: { automatic: true } },
    { name: 'upload then Select', picker: { select: true } },
  ])(
    'completes the delayed Drive picker using $name',
    async ({ picker }) => {
      const fixture = await googleFormsFixture({ picker });
      const browser = await GoogleFormsBrowser.open({
        url: fixture.url,
        fixtureOrigin: fixture.origin,
        storage: fixture.storage,
        headless: true,
      });
      try {
        await browser.inspect();
        const answers = [
          answer('entry.101', 'Ada'),
          answer('entry.202', 'ada@example.com'),
          answer('entry.404', null, fixture.document.id),
        ];
        await browser.fill(answers, [fixture.document]);
        expect(await browser.page.locator('iframe').count()).toBe(0);
        expect(await browser.page.locator('#attached-file').innerText()).toBe(
          fixture.document.name,
        );
        expect(fixture.uploads).toHaveLength(1);
        expect(fixture.uploads[0]).toEqual(
          (await fixture.storage.resolve(fixture.document, ['.pdf'])).buffer,
        );
        await browser.inspect();
        await browser.fill(answers, [fixture.document]);
        expect(fixture.uploads).toHaveLength(1);
        expect(fixture.submissions).toHaveLength(0);
      } finally {
        await browser.close();
        await fixture.close();
      }
    },
    60000,
  );
  it('rejects hidden draft answers that were never prepared or reviewed', async () => {
    const fixture = await googleFormsFixture({
      controls: `<input type="hidden" name="draftResponse" value='[[[null,999,["Unreviewed salary"],0]],null,"fixture-token"]'>`,
    });
    const browser = await GoogleFormsBrowser.open({
      url: fixture.url,
      fixtureOrigin: fixture.origin,
      storage: fixture.storage,
      headless: true,
    });
    try {
      await browser.inspect();
      await browser.fill(
        [answer('entry.101', 'Ada'), answer('entry.202', 'ada@example.com')],
        [],
      );
      await expect(
        browser.submit(identity, {
          authorize: async () => {},
          transport: async () => {},
        }),
      ).rejects.toThrow('GOOGLE_FORMS_UNAPPROVED_DRAFT');
      expect(fixture.submissions).toHaveLength(0);
    } finally {
      await browser.close();
      await fixture.close();
    }
  }, 45000);
  it('refuses a confirmation already present before dispatch', async () => {
    const fixture = await googleFormsFixture({ forgedConfirmation: true });
    const browser = await GoogleFormsBrowser.open({
      url: fixture.url,
      fixtureOrigin: fixture.origin,
      storage: fixture.storage,
      headless: true,
    });
    try {
      await browser.inspect();
      await browser.fill(
        [answer('entry.101', 'Ada'), answer('entry.202', 'ada@example.com')],
        [],
      );
      await expect(
        browser.submit(identity, {
          authorize: async () => {},
          transport: async () => {},
        }),
      ).rejects.toThrow('GOOGLE_FORMS_PREEXISTING_CONFIRMATION');
      expect(fixture.submissions).toHaveLength(0);
    } finally {
      await browser.close();
      await fixture.close();
    }
  }, 45000);
  it('rejects altered submitted values even when JavaScript changes them after the checks', async () => {
    const fixture = await googleFormsFixture({
      controls: `<script>document.querySelector('form').addEventListener('submit', () => { document.querySelector('[name="entry.101"]').value = 'Unapproved'; });</script>`,
    });
    const browser = await GoogleFormsBrowser.open({
      url: fixture.url,
      fixtureOrigin: fixture.origin,
      storage: fixture.storage,
      headless: true,
    });
    try {
      await browser.inspect();
      await browser.fill(
        [answer('entry.101', 'Ada'), answer('entry.202', 'ada@example.com')],
        [],
      );
      expect(
        (
          await browser.submit(identity, {
            authorize: async () => {},
            transport: async () => {},
          })
        ).confirmed,
      ).toBe(false);
      expect(fixture.submissions).toHaveLength(0);
    } finally {
      await browser.close();
      await fixture.close();
    }
  }, 60000);
  it('validates choices and composite dates and clears unknown optional text', async () => {
    const fixture = await googleFormsFixture({
      controls: `
      <section data-google-question><h2 role="heading">Work style *</h2><div role="radiogroup"><label><input name="entry.501" type="radio" value="Remote" required>Remote</label><label><input name="entry.501" type="radio" value="Office">Office</label></div></section>
      <section data-google-question><h2 role="heading">Skills *</h2><label><input name="entry.502" type="checkbox" value="TypeScript">TypeScript</label><label><input name="entry.502" type="checkbox" value="Python">Python</label></section>
      <section data-google-question><h2 role="heading">Degree *</h2><select name="entry.503" required><option value="">Select</option><option>Bachelor</option><option>Master</option></select></section>
      <section data-google-question data-params='[504,"Start date",null,9,[[504]]]'><h2 role="heading">Start date *</h2><input name="entry.504_year" aria-label="Year" type="number" required><input name="entry.504_month" aria-label="Month" type="number" required><input name="entry.504_day" aria-label="Day" type="number" required></section>
      <section data-google-question><h2 role="heading">Optional note</h2><input name="entry.505" value="Unknown prefill"></section>`,
    });
    const browser = await GoogleFormsBrowser.open({
      url: fixture.url,
      fixtureOrigin: fixture.origin,
      storage: fixture.storage,
      headless: true,
    });
    try {
      const inspection = await browser.inspect();
      expect(inspection.questions.find((q) => q.id === 'entry.504')?.kind).toBe(
        'DATE',
      );
      const answers = [
        answer('entry.101', 'Ada'),
        answer('entry.202', 'ada@example.com'),
        answer('entry.501', 'Remote'),
        answer('entry.502', ['TypeScript', 'Python']),
        answer('entry.503', 'Bachelor'),
        answer('entry.504', '2026-11-07'),
        answer('entry.505', null),
      ];
      await browser.fill(answers, []);
      await browser.page.getByLabel('Day', { exact: true }).fill('8');
      await expect(browser.validateFilled(answers)).rejects.toThrow(
        'GOOGLE_FORMS_VALUE_CHANGED',
      );
      await browser.page.getByLabel('Day', { exact: true }).fill('7');
      expect(
        (
          await browser.submit(identity, {
            authorize: async () => {},
            transport: async () => {},
          })
        ).confirmed,
      ).toBe(true);
      expect(fixture.submissions).toHaveLength(1);
      expect(fixture.submissions[0]?.toString()).not.toContain('Unknown');
    } finally {
      await browser.close();
      await fixture.close();
    }
  }, 45000);
  it('inspects native questions, fills approved profile values, and submits exactly once', async () => {
    const fixture = await googleFormsFixture();
    const browser = await GoogleFormsBrowser.open({
      url: fixture.url,
      fixtureOrigin: fixture.origin,
      storage: fixture.storage,
      headless: true,
    });
    try {
      const inspection = await browser.inspect();
      expect(inspection.questions.map((q) => q.id)).toEqual([
        'entry.101',
        'entry.202',
      ]);
      await browser.fill(
        [
          answer('entry.101', 'Ada Lovelace'),
          answer('entry.202', 'ada@example.com'),
        ],
        [],
      );
      const authorize = vi.fn(async () => {}),
        transport = vi.fn(async () => {});
      const outcome = await browser.submit(identity, { authorize, transport });
      expect(outcome.confirmed).toBe(true);
      expect(fixture.submissions).toHaveLength(1);
      expect(authorize).toHaveBeenCalledOnce();
      expect(transport).toHaveBeenCalledOnce();
      expect(fixture.submissions[0]?.toString()).toContain('ada%40example.com');
      await expect(
        browser.submit(identity, { authorize, transport }),
      ).rejects.toThrow();
      expect(fixture.submissions).toHaveLength(1);
    } finally {
      await browser.close();
      await fixture.close();
    }
  }, 45000);
  it('uses a separate Next contract at the shared endpoint and carries the earlier section forward', async () => {
    const fixture = await googleFormsFixture({ sections: true });
    const browser = await GoogleFormsBrowser.open({
      url: fixture.url,
      fixtureOrigin: fixture.origin,
      storage: fixture.storage,
      headless: true,
    });
    const observer = { authorize: async () => {}, transport: async () => {} };
    try {
      expect((await browser.inspect()).next).toBe(true);
      await browser.fill([answer('entry.101', 'Ada Lovelace')], []);
      const next = await browser.next(identity, observer);
      expect(next.questions.map((q) => q.id)).toEqual(['entry.202']);
      expect(fixture.nextRequests).toHaveLength(1);
      expect(fixture.submissions).toHaveLength(0);
      await browser.fill([answer('entry.202', 'ada@example.com')], []);
      expect((await browser.submit(identity, observer)).confirmed).toBe(true);
      expect(fixture.submissions).toHaveLength(1);
      expect(fixture.submissions[0]?.toString()).toContain('Ada+Lovelace');
    } finally {
      await browser.close();
      await fixture.close();
    }
  }, 45000);
  it('fills four sections including an informational page, collected email and Google protocol fields', async () => {
    const fixture = await googleFormsFixture({
      sections: 4,
      emptySection: true,
      collectedEmail: true,
      googleProtocol: true,
      blurValidation: true,
      navigationDelay: 300,
    });
    const browser = await GoogleFormsBrowser.open({
      url: fixture.url,
      fixtureOrigin: fixture.origin,
      storage: fixture.storage,
      headless: true,
    });
    const observer = {
      authorize: vi.fn(async () => {}),
      transport: vi.fn(async () => {}),
    };
    try {
      const first = await browser.inspect();
      expect(first.questions.map((q) => q.id)).toEqual([
        'emailAddress',
        'entry.101',
      ]);
      await browser.fill(
        [
          answer('emailAddress', 'ada@example.com'),
          answer('entry.101', 'Ada Lovelace'),
        ],
        [],
      );
      const second = await browser.next(identity, observer);
      expect(second.questions).toEqual([]);
      expect(second.next).toBe(true);
      expect(second.fingerprint).not.toBe(first.fingerprint);
      await browser.fill([], []);
      const third = await browser.next(identity, observer);
      expect(third.questions.map((q) => q.id)).toEqual(['entry.302']);
      await browser.fill([answer('entry.302', 'Bachelor of Engineering')], []);
      const final = await browser.next(identity, observer);
      expect(final.questions.map((q) => q.id)).toEqual(['entry.202']);
      expect(final.submit).toBe(true);
      expect(fixture.nextRequests).toHaveLength(3);
      expect(fixture.submissions).toHaveLength(0);
      await browser.fill([answer('entry.202', 'ada@example.com')], []);
      expect((await browser.submit(identity, observer)).confirmed).toBe(true);
      expect(fixture.submissions).toHaveLength(1);
      const payload = new URLSearchParams(fixture.submissions[0]!.toString());
      expect(payload.get('emailAddress')).toBe('ada@example.com');
      expect(payload.get('entry.101')).toBe('Ada Lovelace');
      expect(payload.get('entry.302')).toBe('Bachelor of Engineering');
      expect(payload.get('entry.202')).toBe('ada@example.com');
      expect(payload.get('pageHistory')).toBe('0,1,2,3');
      expect(observer.authorize).toHaveBeenCalledTimes(4);
      expect(observer.transport).toHaveBeenCalledTimes(4);
    } finally {
      await browser.close();
      await fixture.close();
    }
  }, 45000);
  it('keeps an attachment uploaded on the first section bound through later sections', async () => {
    const fixture = await googleFormsFixture({
      sections: 3,
      emptySection: true,
      picker: { automatic: true },
      googleProtocol: true,
    });
    const browser = await GoogleFormsBrowser.open({
      url: fixture.url,
      fixtureOrigin: fixture.origin,
      storage: fixture.storage,
      headless: true,
    });
    const observer = { authorize: async () => {}, transport: async () => {} };
    try {
      await browser.inspect();
      await browser.fill(
        [
          answer('entry.101', 'Ada'),
          answer('entry.404', null, fixture.document.id),
        ],
        [fixture.document],
      );
      expect(fixture.uploads).toHaveLength(1);
      await browser.next(identity, observer);
      await browser.fill([], []);
      const final = await browser.next(identity, observer);
      expect(final.questions.map((q) => q.id)).toEqual(['entry.202']);
      await browser.fill([answer('entry.202', 'ada@example.com')], []);
      expect((await browser.submit(identity, observer)).confirmed).toBe(true);
      expect(fixture.uploads).toHaveLength(1);
      expect(fixture.submissions).toHaveLength(1);
      const payload = new URLSearchParams(fixture.submissions[0]!.toString());
      expect(payload.get('entry.404')).toBe('fixture-file-id');
      expect(payload.get('fuIds')).toBe('404');
    } finally {
      await browser.close();
      await fixture.close();
    }
  }, 45000);
  it('rejects changes to collected email and unexpected draft timestamps before advancing', async () => {
    for (const field of ['emailAddress', 'dlut']) {
      const fixture = await googleFormsFixture({
        sections: true,
        collectedEmail: true,
        googleProtocol: true,
      });
      const browser = await GoogleFormsBrowser.open({
        url: fixture.url,
        fixtureOrigin: fixture.origin,
        storage: fixture.storage,
        headless: true,
      });
      try {
        await browser.inspect();
        await browser.fill(
          [
            answer('emailAddress', 'ada@example.com'),
            answer('entry.101', 'Ada'),
          ],
          [],
        );
        await browser.page
          .locator(`[name="${field}"]`)
          .evaluate((element, field) => {
            (element as HTMLInputElement).value =
              field === 'emailAddress'
                ? 'someone-else@example.com'
                : 'unapproved';
          }, field);
        await expect(
          browser.next(identity, {
            authorize: async () => {},
            transport: async () => {},
          }),
        ).rejects.toThrow(
          field === 'emailAddress'
            ? 'GOOGLE_FORMS_UNAPPROVED_VALUE'
            : 'GOOGLE_FORMS_UNEXPECTED_FORM_FIELD',
        );
        expect(fixture.nextRequests).toHaveLength(0);
        expect(fixture.submissions).toHaveLength(0);
      } finally {
        await browser.close();
        await fixture.close();
      }
    }
  }, 45000);
  it('uploads the approved PDF bytes and binds them to the multipart submission', async () => {
    const fixture = await googleFormsFixture({ upload: true });
    const browser = await GoogleFormsBrowser.open({
      url: fixture.url,
      fixtureOrigin: fixture.origin,
      storage: fixture.storage,
      headless: true,
    });
    try {
      await browser.inspect();
      await browser.fill(
        [
          answer('entry.101', 'Ada'),
          answer('entry.202', 'ada@example.com'),
          answer('entry.404', null, fixture.document.id),
        ],
        [fixture.document],
      );
      const outcome = await browser.submit(identity, {
        authorize: async () => {},
        transport: async () => {},
      });
      expect(outcome.confirmed).toBe(true);
      expect(fixture.submissions).toHaveLength(1);
      expect(fixture.submissions[0]?.toString()).toContain(
        'Controlled Google Forms fixture resume',
      );
    } finally {
      await browser.close();
      await fixture.close();
    }
  }, 45000);
  it('does not treat an HTTP success without confirmation as a confirmed application', async () => {
    const fixture = await googleFormsFixture({ unknown: true });
    const browser = await GoogleFormsBrowser.open({
      url: fixture.url,
      fixtureOrigin: fixture.origin,
      storage: fixture.storage,
      headless: true,
    });
    try {
      await browser.inspect();
      await browser.fill(
        [answer('entry.101', 'Ada'), answer('entry.202', 'ada@example.com')],
        [],
      );
      expect(
        (
          await browser.submit(identity, {
            authorize: async () => {},
            transport: async () => {},
          })
        ).confirmed,
      ).toBe(false);
      expect(fixture.submissions).toHaveLength(1);
    } finally {
      await browser.close();
      await fixture.close();
    }
  }, 60000);
});
