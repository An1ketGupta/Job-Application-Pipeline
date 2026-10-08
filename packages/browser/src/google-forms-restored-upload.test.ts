import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import { expect, it } from 'vitest';
import type { GoogleFormAnswer, UserDocument } from '@careerlift/domain';
import { GoogleFormsBrowser } from './google-forms-browser.js';

it('replaces a restored attachment using Add File and advances with the verified upload', async () => {
  const bytes = Buffer.from('%PDF-1.7\nApproved resume bytes\n%%EOF');
  const document: UserDocument = {
    id: 'approved-resume',
    name: 'Resume.pdf',
    type: 'RESUME',
    mimeType: 'application/pdf',
    size: bytes.length,
    storageRef: 'local://resume.pdf',
    metadata: {
      contentDigest: createHash('sha256').update(bytes).digest('hex'),
    },
  };
  const answer: GoogleFormAnswer = {
    id: 'entry.404',
    value: null,
    documentId: document.id,
    source: 'DOCUMENT',
    evidenceIds: [],
    review: null,
  };
  const uploads: Buffer[] = [];
  const transitions: URLSearchParams[] = [];
  const server = createServer(async (request, response) => {
    if (request.method === 'POST') {
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      const body = Buffer.concat(chunks);
      if (request.url === '/upload/fixture') {
        uploads.push(body);
        response.end('verified-upload');
      } else {
        transitions.push(new URLSearchParams(body.toString()));
        response.setHeader('Content-Type', 'text/html');
        response.end(
          '<form method="post" action="/formResponse"><h1>Second section</h1><input type="hidden" name="entry.404" value="verified-upload"><input type="hidden" name="pageHistory" value="0,1"><button>Submit</button></form>',
        );
      }
      return;
    }
    response.setHeader('Content-Type', 'text/html');
    response.end(`<!doctype html><html><body>
      <form method="post" action="/formResponse"><h1>Application</h1>
        <input type="hidden" name="pageHistory" value="0">
        <section data-google-question data-params='[404,"Resume",null,13,[[404]]]'>
          <h2 role="heading">Resume *</h2>
          <input type="hidden" id="file-id" name="entry.404" value="restored-unverified">
          <div id="attachment"><button type="button" aria-label="Open file" onclick="window.open('/preview', '_blank')">Resume.pdf</button>
            <button type="button" aria-label="Remove file" onclick="removeAttachment()">Remove</button></div>
          <button type="button" aria-label="Add File" onclick="openPicker()">Add File</button>
        </section>
        <button type="submit" name="continue" value="1">Next</button>
      </form>
      <script>
        function removeAttachment() {
          document.querySelector('#attachment').replaceChildren();
          document.querySelector('#file-id').value = '';
          document.querySelector('form').setAttribute('data-restored-removed', 'true');
        }
        function openPicker() {
          const dialog = document.createElement('div');
          dialog.innerHTML = '<button type="button" role="tab" aria-selected="true">Upload</button><input type="file" style="display:none">';
          document.body.append(dialog);
          dialog.querySelector('input').onchange = async event => {
            const file = event.target.files[0];
            const token = await fetch('/upload/fixture', {method:'POST',body:await file.arrayBuffer()}).then(response => response.text());
            document.querySelector('#file-id').value = token;
            document.querySelector('#attachment').textContent = file.name;
            dialog.remove();
          };
        }
      </script>
    </body></html>`);
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
        resolve: async () => ({
          name: document.name,
          mimeType: document.mimeType,
          buffer: bytes,
        }),
      },
    });
    let previews = 0;
    browser.context.on('page', () => {
      previews++;
    });
    const first = await browser.inspect();
    expect(first.questions.map((question) => question.id)).toEqual([
      'entry.404',
    ]);
    await browser.fill([answer], [document]);
    expect(
      await browser.page.locator('form').getAttribute('data-restored-removed'),
    ).toBe('true');
    expect(previews).toBe(0);
    expect(uploads).toEqual([bytes]);
    expect(await browser.page.locator('#file-id').inputValue()).toBe(
      'verified-upload',
    );
    expect(browser.networkFailure()).toBeNull();
    const second = await browser.next(
      {
        applicationId: 'application',
        runId: 'run',
        userId: 'owner',
        version: 1,
      },
      { authorize: async () => {}, transport: async () => {} },
    );
    expect(second.title).toBe('Second section');
    expect(second.submit).toBe(true);
    expect(transitions).toHaveLength(1);
    expect(transitions[0]!.get('entry.404')).toBe('verified-upload');
    expect(transitions[0]!.get('continue')).toBe('1');
    expect(transitions[0]!.toString()).not.toContain('restored-unverified');
  } finally {
    await browser?.close();
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }
}, 45000);
