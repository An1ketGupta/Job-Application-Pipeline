import { createServer } from 'node:http';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import { describe, expect, it, vi } from 'vitest';
import type { GoogleFormAnswer } from '@careerlift/domain';
import { GoogleFormsBrowser } from './google-forms-browser.js';

const answer = (id: string, value: string | null): GoogleFormAnswer => ({
  id,
  value,
  documentId: null,
  source: 'REVIEW',
  evidenceIds: [],
  review: null,
});

function dropdown(id: number, required = true) {
  const options = [
    '',
    'Product design intern',
    'Product intern',
    'Unavailable',
  ];
  return `<section class="Qr7Oae" data-params='[${id},"Role",null,3,[[${id}]]]'>
    <h2 role="heading">Role ${id}${required ? ' *' : ''}</h2>
    <div role="listbox" tabindex="0" aria-expanded="false">
      <div jsname="LgbsSe">${options
        .map(
          (value) => `<div role="option" data-value="${value}"
          aria-selected="${value === ''}" ${value === 'Unavailable' ? 'aria-disabled="true"' : ''}>
          <span>${value || 'Choose'}</span></div>`,
        )
        .join('')}</div>
      <div jsname="V68bde" style="display:none"></div>
    </div>
    <input type="hidden" name="entry.${id}" value="">
  </section>`;
}

async function withForm(
  controls: string,
  run: (
    browser: GoogleFormsBrowser,
    submissions: URLSearchParams[],
  ) => Promise<void>,
  selectionDelay = 0,
) {
  const submissions: URLSearchParams[] = [];
  const server = createServer(async (request, response) => {
    response.setHeader('Content-Type', 'text/html');
    if (request.method === 'POST') {
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      submissions.push(new URLSearchParams(Buffer.concat(chunks).toString()));
      response.end(
        '<div data-google-confirmation>Your response has been recorded.</div>',
      );
      return;
    }
    response.end(`<!doctype html><html><head><style>
      [jsname="LgbsSe"] [role="option"]:not([aria-selected="true"]) { display:none }
      [role="option"] { padding:8px }
    </style></head><body><form method="post" action="/formResponse">
      <h1>Dropdown regression</h1>${controls}<button type="submit">Submit</button>
    </form><script>
      document.querySelectorAll('[role="listbox"]').forEach(listbox => {
        let pendingSelection;
        listbox.addEventListener('focusout', event => {
          if (listbox.contains(event.relatedTarget)) return;
          clearTimeout(pendingSelection);
          listbox.setAttribute('aria-expanded', 'false');
          listbox.querySelector('[jsname="V68bde"]').style.display = 'none';
        });
        listbox.addEventListener('click', event => {
          const menu = listbox.querySelector('[jsname="V68bde"]');
          const option = event.target.closest('[role="option"]');
          if (option && menu.contains(option)) {
            if (option.getAttribute('aria-disabled') === 'true') return;
            const value = option.getAttribute('data-value');
            const commit = () => {
              listbox.querySelectorAll('[jsname="LgbsSe"] [role="option"]').forEach(original => {
                original.setAttribute('aria-selected', String(original.getAttribute('data-value') === value));
              });
              listbox.closest('section').querySelector('input').value = value;
              listbox.setAttribute('aria-expanded', 'false');
              menu.style.display = 'none';
            };
            if (${selectionDelay}) pendingSelection = setTimeout(commit, ${selectionDelay});
            else commit();
          } else if (listbox.getAttribute('aria-expanded') !== 'true') {
            listbox.setAttribute('aria-expanded', 'true');
            setTimeout(() => {
              menu.innerHTML = listbox.querySelector('[jsname="LgbsSe"]').innerHTML;
              menu.style.display = 'block';
            }, 100);
          }
        });
      });
    </script></body></html>`);
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
          throw new Error('No documents in the dropdown fixture');
        },
      },
    });
    await run(browser, submissions);
  } finally {
    await browser?.close();
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }
}

describe('Google Forms custom dropdowns', () => {
  it('waits for Google to commit its delayed selection before filling the next question or blurring', async () => {
    await withForm(
      dropdown(101) +
        '<section data-google-question><h2 role="heading">Next question *</h2><input name="entry.202" required></section>',
      async (browser) => {
        const inspection = await browser.inspect();
        const answers = [
          answer('entry.101', 'Product intern'),
          answer('entry.202', 'Next answer'),
        ];
        await browser.fill(answers, []);
        expect(
          await browser.page.getByRole('listbox').getAttribute('aria-expanded'),
        ).toBe('false');
        expect(
          await browser.page.locator('[name="entry.101"]').inputValue(),
        ).toBe('Product intern');
        expect((await browser.inspect()).fingerprint).toBe(
          inspection.fingerprint,
        );
        await browser.validateFilled(answers);
      },
      350,
    );
  }, 45000);

  it('extracts real choices and keeps the fingerprint stable when Google clones the popup', async () => {
    await withForm(dropdown(101), async (browser) => {
      const inspection = await browser.inspect();
      expect(inspection.questions[0]).toMatchObject({
        id: 'entry.101',
        kind: 'SELECT',
        options: ['Product design intern', 'Product intern'],
      });
      await browser.page.getByRole('listbox').click();
      await browser.page
        .locator('[jsname="V68bde"]')
        .waitFor({ state: 'visible' });
      expect((await browser.inspect()).fingerprint).toBe(
        inspection.fingerprint,
      );
      await browser.fill([answer('entry.101', 'Product intern')], []);
      expect(
        await browser.page.locator('[name="entry.101"]').inputValue(),
      ).toBe('Product intern');
    });
  }, 45000);

  it('selects shared labels in the correct popup and submits the selected values once', async () => {
    await withForm(
      dropdown(101) + dropdown(202),
      async (browser, submissions) => {
        await browser.inspect();
        const answers = [
          answer('entry.101', 'Product intern'),
          answer('entry.202', 'Product intern'),
        ];
        await browser.fill(answers, []);
        const observer = {
          authorize: vi.fn(async () => {}),
          transport: vi.fn(async () => {}),
        };
        const result = await browser.submit(
          {
            applicationId: 'application',
            runId: 'run',
            userId: 'owner',
            version: 1,
          },
          observer,
        );
        expect(result.confirmed).toBe(true);
        expect(submissions).toHaveLength(1);
        expect(submissions[0]?.get('entry.101')).toBe('Product intern');
        expect(submissions[0]?.get('entry.202')).toBe('Product intern');
        expect(observer.authorize).toHaveBeenCalledOnce();
      },
    );
  }, 45000);

  it('clears an optional custom dropdown back to Choose without approving the placeholder as an answer', async () => {
    await withForm(dropdown(101, false), async (browser) => {
      await browser.inspect();
      await browser.fill([answer('entry.101', 'Product intern')], []);
      await browser.fill([answer('entry.101', null)], []);
      expect(
        await browser.page.locator('[name="entry.101"]').inputValue(),
      ).toBe('');
      await expect(
        browser.prepareSubmit({
          applicationId: 'application',
          runId: 'run',
          userId: 'owner',
          version: 1,
        }),
      ).resolves.toBeDefined();
    });
  }, 45000);

  it('rejects a changed selection before submission', async () => {
    await withForm(dropdown(101), async (browser, submissions) => {
      await browser.inspect();
      const answers = [answer('entry.101', 'Product intern')];
      await browser.fill(answers, []);
      await browser.page
        .locator('[jsname="LgbsSe"] [role="option"]')
        .evaluateAll((options) => {
          for (const option of options)
            option.setAttribute(
              'aria-selected',
              String(
                option.getAttribute('data-value') === 'Product design intern',
              ),
            );
        });
      await expect(browser.validateFilled(answers)).rejects.toThrow(
        'GOOGLE_FORMS_VALUE_CHANGED',
      );
      expect(submissions).toHaveLength(0);
    });
  }, 45000);

  it('rejects duplicate matching choices inside the active popup', async () => {
    await withForm(dropdown(101), async (browser, submissions) => {
      await browser.inspect();
      await browser.page.locator('[jsname="LgbsSe"]').evaluate((trigger) => {
        trigger.appendChild(
          trigger
            .querySelector('[data-value="Product intern"]')!
            .cloneNode(true),
        );
      });
      await expect(
        browser.fill([answer('entry.101', 'Product intern')], []),
      ).rejects.toThrow('GOOGLE_FORMS_AMBIGUOUS_OPTION');
      expect(submissions).toHaveLength(0);
    });
  }, 45000);
});
