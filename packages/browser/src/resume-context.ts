import type {
  ApplicationSchema,
  ReviewDecision,
  UserDocument,
  ResumeContext,
} from '@careerlift/domain';
import type { LocalDocumentStorage } from './document-storage.js';

export function selectApplicationResume(
  documents: UserDocument[],
  schema?: ApplicationSchema,
  decisions: ReviewDecision[] = [],
) {
  const requirement = schema?.documents.find((d) => d.type === 'RESUME');
  const candidates = documents.filter(
    (d) =>
      d.type === 'RESUME' &&
      (!requirement?.acceptedFileTypes.length ||
        requirement.acceptedFileTypes.some(
          (type) =>
            type.toLowerCase() === d.mimeType.toLowerCase() ||
            d.name.toLowerCase().endsWith(type.toLowerCase()),
        )),
  );
  const decision = requirement
    ? [...decisions]
        .reverse()
        .find(
          (d) =>
            d.requirementId === requirement.fieldId &&
            d.action === 'SELECT_DOCUMENT',
        )
    : undefined;
  if (decision) return candidates.find((d) => d.id === decision.documentId);
  const defaults = candidates.filter((d) => d.metadata.isDefault === true);
  return defaults.length === 1
    ? defaults[0]
    : candidates.length === 1
      ? candidates[0]
      : undefined;
}

export async function extractResumeContext(
  storage: Pick<LocalDocumentStorage, 'resolve'>,
  document?: UserDocument,
): Promise<ResumeContext> {
  if (!document)
    return { documentId: null, name: null, text: '', status: 'MISSING' };
  const context = {
    documentId: document.id,
    name: document.name,
    text: '',
    status: 'UNREADABLE' as const,
  };
  try {
    const file = await storage.resolve(document, []);
    let text = '';
    if (file.mimeType === 'text/plain') text = file.buffer.toString('utf8');
    else {
      const { getDocument } = await import('pdfjs-dist/legacy/build/pdf.mjs');
      const task = getDocument({
        data: new Uint8Array(file.buffer),
        useSystemFonts: true,
        verbosity: 0,
      });
      try {
        const pdf = await task.promise;
        if (pdf.numPages > 100) return context;
        for (let index = 1; index <= pdf.numPages; index++) {
          const page = await pdf.getPage(index);
          const content = await page.getTextContent();
          text +=
            content.items
              .map((item) =>
                'str' in item ? item.str + (item.hasEOL ? '\n' : ' ') : '',
              )
              .join('') + '\n';
          // Never silently omit resume information that may conflict with the profile.
          if (text.length > 200000) return context;
          page.cleanup();
        }
      } finally {
        await task.destroy();
      }
    }
    if (!text.trim() || text.length > 200000) return context;
    return { ...context, text: text.trim(), status: 'READY' };
  } catch {
    return context;
  }
}
