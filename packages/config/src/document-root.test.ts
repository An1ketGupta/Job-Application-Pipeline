import { describe, expect, it } from 'vitest';
import { resolve, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveDocumentRoot } from './index.js';
describe('shared existing document root', () => {
  it('preserves the worker directory default and absolute configuration for API and worker', () => {
    const worker = fileURLToPath(
      new URL('../../../apps/worker/', import.meta.url),
    );
    expect(resolveDocumentRoot()).toBe(resolve(worker, 'documents'));
    const absolute = resolve('test-documents');
    expect(resolveDocumentRoot(absolute)).toBe(absolute);
    expect(isAbsolute(resolveDocumentRoot('./documents'))).toBe(true);
  });
});
