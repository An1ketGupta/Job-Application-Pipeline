import { describe, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LocalDocumentStorage } from './document-storage.js';
import {
  extractResumeContext,
  selectApplicationResume,
} from './resume-context.js';

function pdfWithText(text: string) {
  const stream = `BT /F1 12 Tf 50 750 Td (${text}) Tj ET`;
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
    `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`,
  ];
  let content = '%PDF-1.4\n';
  const offsets = [0];
  objects.forEach((object, index) => {
    offsets.push(Buffer.byteLength(content));
    content += `${index + 1} 0 obj\n${object}\nendobj\n`;
  });
  const xref = Buffer.byteLength(content);
  content += `xref\n0 6\n0000000000 65535 f \n${offsets
    .slice(1)
    .map((offset) => `${String(offset).padStart(10, '0')} 00000 n \n`)
    .join('')}trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`;
  return Buffer.from(content);
}
describe('selected resume context', () => {
  it('extracts real PDF/TXT contents through verified owned storage and fails safely on unreadable PDFs', async () => {
    const root = await mkdtemp(join(tmpdir(), 'resume-context-'));
    const storage = new LocalDocumentStorage(root);
    try {
      const pdf = await storage.upload(
        'resume.pdf',
        'RESUME',
        pdfWithText('Ada worked at Example in 2022.'),
      );
      expect(await extractResumeContext(storage, pdf)).toMatchObject({
        documentId: pdf.id,
        status: 'READY',
        text: 'Ada worked at Example in 2022.',
      });
      const txt = await storage.upload(
        'resume.txt',
        'RESUME',
        Buffer.from('Full resume\nPython engineer.'),
      );
      expect((await extractResumeContext(storage, txt)).text).toBe(
        'Full resume\nPython engineer.',
      );
      const bad = await storage.upload(
        'broken.pdf',
        'RESUME',
        Buffer.from('%PDF-not-readable'),
      );
      expect((await extractResumeContext(storage, bad)).status).toBe(
        'UNREADABLE',
      );
      expect(
        (
          await extractResumeContext(storage, {
            ...txt,
            metadata: { contentDigest: '0'.repeat(64) },
          })
        ).status,
      ).toBe('UNREADABLE');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
  it('preserves explicit application selection and refuses ambiguous resume variants', () => {
    const docs = ['one', 'two'].map((id) => ({
      id,
      type: 'RESUME' as const,
      name: `${id}.txt`,
      storageRef: `local://${id}.txt`,
      mimeType: 'text/plain',
      size: 10,
      metadata: {},
    }));
    expect(selectApplicationResume(docs)).toBeUndefined();
    expect(
      selectApplicationResume(
        docs,
        {
          documents: [
            { fieldId: 'resume', type: 'RESUME', acceptedFileTypes: [] },
          ],
        } as never,
        [
          {
            requirementId: 'resume',
            action: 'SELECT_DOCUMENT',
            documentId: 'two',
            key: 'key',
            actorId: 'user',
            decidedAt: new Date().toISOString(),
          },
        ],
      ),
    ).toEqual(docs[1]);
  });
});
