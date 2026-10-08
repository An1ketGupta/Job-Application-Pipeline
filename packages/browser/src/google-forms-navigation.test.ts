import { createServer } from 'node:http';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import { describe, expect, it, vi } from 'vitest';
import type { GoogleFormAnswer } from '@careerlift/domain';
import {
  GoogleFormsBrowser,
  googleFormsBackgroundRequest,
} from './google-forms-browser.js';

const identity = {
  applicationId: 'application',
  runId: 'run',
  userId: 'owner',
  version: 1,
};
const answer = (id: string, value: string): GoogleFormAnswer => ({
  id,
  value,
  documentId: null,
  source: 'REVIEW',
  evidenceIds: [],
  review: null,
});

async function withSections(
  run: (
    browser: GoogleFormsBrowser,
    origin: string,
    requests: URLSearchParams[],
  ) => Promise<void>,
  delayedQuestion = false,
) {
  const requests: URLSearchParams[] = [];
  const saved = new Map<string, string>();
  const render = (section: number) => {
    const draft = JSON.stringify([
      [...saved].map(([name, value]) => [
        null,
        Number(name.slice(6)),
        [value],
        0,
      ]),
      null,
      'fixture-token',
    ]);
    return `<!doctype html><html><body><form method="post" action="/formResponse">
      <h1>Multi-page application</h1>
      <section class="Qr7Oae"><h2 role="heading">Show Us What You've Built</h2><p>Instructions for this section.</p></section>
      <input type="hidden" name="pageHistory" value="${Array.from({ length: section + 1 }, (_, i) => i).join(',')}">
      <input type="hidden" name="draftResponse" value='${draft}'>
      <section data-google-question ${delayedQuestion && section === 1 ? 'style="display:none"' : ''}><h2 role="heading">Question ${section + 1} *</h2>
        <textarea name="entry.${section + 101}" required></textarea>
      </section>
      ${section < 2 ? '<button type="submit" name="continue" value="1">Next</button>' : '<button type="submit">Submit</button>'}
    </form>${delayedQuestion && section === 1 ? '<script>setTimeout(() => document.querySelector("section[data-google-question]").style.display = "block", 180);</script>' : ''}</body></html>`;
  };
  const server = createServer(async (request, response) => {
    response.setHeader('Content-Type', 'text/html');
    if (request.method === 'POST') {
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      const data = new URLSearchParams(Buffer.concat(chunks).toString());
      requests.push(data);
      for (const [name, value] of data)
        if (name.startsWith('entry.')) saved.set(name, value);
      const section = data.get('pageHistory')!.split(',').length;
      response.end(
        data.has('continue')
          ? render(section)
          : '<div data-google-confirmation>Your response has been recorded.</div>',
      );
      return;
    }
    const section = Number(request.url?.match(/^\/section\/(\d+)$/)?.[1] ?? 0);
    response.end(render(section));
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  let browser: GoogleFormsBrowser | undefined;
  try {
    browser = await GoogleFormsBrowser.open({
      url: `${origin}/viewform`,
      fixtureOrigin: origin,
      headless: true,
      storage: {
        resolve: async () => {
          throw new Error('No uploads in this fixture');
        },
      },
    });
    await run(browser, origin, requests);
  } finally {
    await browser?.close();
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }
}

describe('Google Forms section navigation', () => {
  it('skips section headings while retaining questions with unsupported controls', async () => {
    await withSections(async (browser) => {
      await browser.page.locator('form').evaluate((form) => {
        form.insertAdjacentHTML(
          'beforeend',
          '<section class="Qr7Oae" data-params=\'[404,"Custom question",null,4,[[404]]]\'><h2 role="heading">Custom question *</h2></section>',
        );
      });
      const inspection = await browser.inspect();
      expect(
        inspection.questions.map((question) => ({
          id: question.id,
          kind: question.kind,
        })),
      ).toEqual([
        { id: 'entry.101', kind: 'PARAGRAPH' },
        { id: 'entry.404', kind: 'UNSUPPORTED' },
      ]);
    });
  }, 45000);
  it('suppresses only read requests for Google cached fonts', () => {
    const canonical =
      'https://docs.google.com/forms/d/e/controlled-form/viewform';
    const font =
      'blob:https://docs.google.com/persistent/docs/fonts/font.woff2';
    expect(googleFormsBackgroundRequest(font, 'GET', canonical)).toBe(true);
    expect(
      googleFormsBackgroundRequest(
        font.replace('blob:', 'filesystem:'),
        'GET',
        canonical,
      ),
    ).toBe(true);
    expect(googleFormsBackgroundRequest(font, 'HEAD', canonical)).toBe(true);
    expect(googleFormsBackgroundRequest(font, 'POST', canonical)).toBe(false);
    expect(
      googleFormsBackgroundRequest(
        'blob:https://docs.google.com/unknown',
        'GET',
        canonical,
      ),
    ).toBe(false);
    expect(
      googleFormsBackgroundRequest(
        'blob:https://unapproved.example/persistent/docs/fonts/font.woff2',
        'GET',
        canonical,
      ),
    ).toBe(false);
  });
  it('still blocks unapproved writes opened in a popup', async () => {
    await withSections(async (browser, _origin, requests) => {
      await browser.inspect();
      const failed = browser.context.waitForEvent('requestfailed', {
        predicate: (request) =>
          request.method() === 'POST' &&
          new URL(request.url()).pathname === '/preview',
        timeout: 5000,
      });
      await browser.page.evaluate(() => {
        const form = document.createElement('form');
        form.method = 'POST';
        form.action = '/preview';
        form.target = '_blank';
        document.body.append(form);
        form.submit();
      });
      await failed;
      expect(browser.networkFailure()?.code).toBe(
        'GOOGLE_FORMS_UNAPPROVED_MUTATION',
      );
      expect(requests).toHaveLength(0);
    });
  }, 45000);
  it('continues after closing an attachment preview popup', async () => {
    await withSections(async (browser, _origin, requests) => {
      await browser.inspect();
      await browser.fill([answer('entry.101', 'First answer')], []);
      const failed = browser.context.waitForEvent('requestfailed', {
        predicate: (request) => new URL(request.url()).pathname === '/preview',
        timeout: 5000,
      });
      await browser.page.evaluate(() => {
        window.open('/preview', '_blank');
      });
      await failed;
      expect(browser.networkFailure()).toBeNull();
      const second = await browser.next(identity, {
        authorize: async () => {},
        transport: async () => {},
      });
      expect(second.questions.map((q) => q.id)).toEqual(['entry.102']);
      expect(requests).toHaveLength(1);
    });
  }, 45000);
  it.each([
    {
      name: 'normal navigation',
      navigateDuringInspection: false,
      delayedQuestion: false,
    },
    {
      name: 'navigation during inspection',
      navigateDuringInspection: true,
      delayedQuestion: false,
    },
    {
      name: 'delayed question hydration',
      navigateDuringInspection: false,
      delayedQuestion: true,
    },
  ])(
    'fills three pages and submits once with $name',
    async ({ navigateDuringInspection, delayedQuestion }) => {
      await withSections(async (browser, origin, requests) => {
        const observer = {
          authorize: vi.fn(async () => {}),
          transport: vi.fn(async () => {}),
        };
        await browser.inspect();
        await browser.fill([answer('entry.101', 'First answer')], []);
        if (navigateDuringInspection) {
          const inspect = browser.inspect.bind(browser);
          vi.spyOn(browser, 'inspect').mockImplementationOnce(async () => {
            // A delayed section navigation destroys an in-flight DOM read.
            const read = browser.page
              .evaluate(
                () =>
                  new Promise<void>((resolve) => setTimeout(resolve, 10000)),
              )
              .catch((error) => error as Error);
            await browser.page.evaluate(() => document.readyState);
            await browser.page.goto(`${origin}/section/1`);
            const result = await read;
            if (result instanceof Error) throw result;
            return inspect();
          });
        }
        const second = await browser.next(identity, observer);
        expect(second.questions.map((q) => q.id)).toEqual(['entry.102']);
        expect(requests).toHaveLength(1);
        expect(requests[0]!.get('continue')).toBe('1');
        await browser.fill([answer('entry.102', 'Second answer')], []);
        const third = await browser.next(identity, observer);
        expect(third.questions.map((q) => q.id)).toEqual(['entry.103']);
        expect(third.submit).toBe(true);
        expect(requests).toHaveLength(2);
        await browser.fill([answer('entry.103', 'Third answer')], []);
        expect((await browser.submit(identity, observer)).confirmed).toBe(true);
        expect(requests).toHaveLength(3);
        expect(requests.filter((data) => !data.has('continue'))).toHaveLength(
          1,
        );
        const draft = JSON.parse(requests[2]!.get('draftResponse')!);
        expect(draft[0]).toEqual([
          [null, 101, ['First answer'], 0],
          [null, 102, ['Second answer'], 0],
        ]);
        expect(requests[2]!.get('entry.103')).toBe('Third answer');
        expect(observer.authorize).toHaveBeenCalledTimes(3);
        expect(observer.transport).toHaveBeenCalledTimes(3);
      }, delayedQuestion);
    },
    45000,
  );
  it('keeps non-navigation inspection errors fatal without replaying Next', async () => {
    await withSections(async (browser, _origin, requests) => {
      await browser.inspect();
      await browser.fill([answer('entry.101', 'First answer')], []);
      vi.spyOn(browser, 'inspect').mockRejectedValueOnce(
        new Error('GOOGLE_FORMS_AMBIGUOUS_QUESTIONS'),
      );
      await expect(
        browser.next(identity, {
          authorize: async () => {},
          transport: async () => {},
        }),
      ).rejects.toThrow('GOOGLE_FORMS_AMBIGUOUS_QUESTIONS');
      expect(requests).toHaveLength(1);
      expect(requests[0]!.has('continue')).toBe(true);
    });
  }, 45000);
});
