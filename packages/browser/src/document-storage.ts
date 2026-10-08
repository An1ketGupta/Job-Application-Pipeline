import { open, realpath, lstat, mkdir, unlink } from 'node:fs/promises';
import { constants } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { basename, extname, isAbsolute, relative, resolve } from 'node:path';
import type { DocumentStorage, UserDocument } from '@careerlift/domain';
import { InspectionError } from './policy.js';

export class LocalDocumentStorage implements DocumentStorage {
  constructor(
    private readonly root: string,
    private readonly maxBytes = 10 * 1024 * 1024,
  ) {}
  async upload(
    name: string,
    type: UserDocument['type'],
    buffer: Buffer,
  ): Promise<UserDocument> {
    if (
      !/^[a-zA-Z0-9][a-zA-Z0-9 _().-]{0,149}\.(pdf|txt)$/i.test(name) ||
      name.includes('..') ||
      /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(name) ||
      !buffer.length ||
      buffer.length > this.maxBytes
    )
      throw new InspectionError(
        'INVALID_DOCUMENT_UPLOAD',
        'Invalid filename or size',
      );
    const extension = extname(name).toLowerCase();
    if (
      extension === '.pdf'
        ? buffer.subarray(0, 5).toString() !== '%PDF-'
        : buffer.includes(0) ||
          !Buffer.from(buffer.toString('utf8')).equals(buffer)
    )
      throw new InspectionError(
        'DOCUMENT_MIME_INVALID',
        'Invalid document content',
      );
    await mkdir(this.root, { recursive: true });
    const root = await realpath(this.root);
    const id = randomUUID();
    const target = resolve(root, `${id}${extension}`);
    const handle = await open(
      target,
      constants.O_WRONLY |
        constants.O_CREAT |
        constants.O_EXCL |
        (constants.O_NOFOLLOW ?? 0),
      0o600,
    );
    try {
      await handle.writeFile(buffer);
    } finally {
      await handle.close();
    }
    const document: UserDocument = {
      id,
      name,
      type,
      storageRef: `local://${id}${extension}`,
      size: buffer.length,
      mimeType: extension === '.pdf' ? 'application/pdf' : 'text/plain',
      metadata: {
        contentDigest: createHash('sha256').update(buffer).digest('hex'),
      },
    };
    try {
      await this.resolve(document, []);
    } catch (error) {
      await unlink(target);
      throw error;
    }
    return document;
  }
  // Used only to compensate an upload that never obtained a database record.
  async discardUpload(document: UserDocument) {
    const key = document.storageRef.replace(/^local:\/\//, '');
    if (!/^[a-f0-9-]{36}\.(pdf|txt)$/.test(key))
      throw new Error('INVALID_UPLOAD_KEY');
    await unlink(resolve(await realpath(this.root), key));
  }
  async resolve(document: UserDocument, accepted: string[]) {
    const key = document.storageRef.replace(/^local:\/\//, '');
    if (
      !document.storageRef.startsWith('local://') ||
      !/^[a-zA-Z0-9_-]+\.(pdf|txt)$/.test(key) ||
      isAbsolute(key) ||
      basename(document.name) !== document.name
    )
      throw new InspectionError(
        'INVALID_DOCUMENT_REFERENCE',
        'Invalid storage key',
      );
    let root: string, target: string;
    try {
      root = await realpath(this.root);
      target = await realpath(resolve(root, key));
    } catch {
      throw new InspectionError('DOCUMENT_MISSING', 'Document unavailable');
    }
    const within = relative(root, target);
    if (within.startsWith('..') || isAbsolute(within))
      throw new InspectionError(
        'DOCUMENT_PATH_ESCAPE',
        'Document escapes storage',
      );
    if ((await lstat(resolve(root, key))).isSymbolicLink())
      throw new InspectionError(
        'DOCUMENT_SYMLINK_BLOCKED',
        'Document symlinks are not allowed',
      );
    const handle = await open(
      target,
      constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0),
    );
    try {
      const stat = await handle.stat();
      if (!stat.isFile())
        throw new InspectionError(
          'DOCUMENT_NOT_FILE',
          'Document is not a regular file',
        );
      if (stat.nlink !== 1)
        throw new InspectionError(
          'DOCUMENT_HARDLINK_BLOCKED',
          'Document must have one filesystem link',
        );
      const identity = await lstat(resolve(root, key));
      if (
        identity.isSymbolicLink() ||
        identity.dev !== stat.dev ||
        identity.ino !== stat.ino
      )
        throw new InspectionError(
          'DOCUMENT_CHANGED',
          'Document storage identity changed',
        );
      if (
        !stat.size ||
        stat.size > this.maxBytes ||
        stat.size !== document.size
      )
        throw new InspectionError(
          'DOCUMENT_SIZE_INVALID',
          'Invalid document size',
        );
      // Read bounded bytes from an open handle, then upload the verified buffer, never a mutable path.
      const buffer = Buffer.alloc(stat.size);
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
      const after = await handle.stat();
      if (
        bytesRead !== stat.size ||
        after.size !== stat.size ||
        after.mtimeMs !== stat.mtimeMs ||
        after.ctimeMs !== stat.ctimeMs
      )
        throw new InspectionError(
          'DOCUMENT_CHANGED',
          'Document changed during read',
        );
      const extension = extname(key).toLowerCase();
      const mimeType = extension === '.pdf' ? 'application/pdf' : 'text/plain';
      if (
        document.mimeType !== mimeType ||
        extname(document.name).toLowerCase() !== extension ||
        (extension === '.pdf'
          ? buffer.subarray(0, 5).toString() !== '%PDF-'
          : buffer.includes(0) ||
            !Buffer.from(buffer.toString('utf8')).equals(buffer))
      )
        throw new InspectionError(
          'DOCUMENT_MIME_INVALID',
          'Document MIME does not match content',
        );
      if (
        accepted.length &&
        !accepted.some(
          (a) => a.toLowerCase() === extension || a.toLowerCase() === mimeType,
        )
      )
        throw new InspectionError(
          'DOCUMENT_TYPE_NOT_ALLOWED',
          'Document type not accepted',
        );
      const expectedDigest = document.metadata.contentDigest;
      if (
        expectedDigest !== undefined &&
        (typeof expectedDigest !== 'string' ||
          !/^[a-f0-9]{64}$/.test(expectedDigest) ||
          createHash('sha256').update(buffer).digest('hex') !== expectedDigest)
      )
        throw new InspectionError(
          'DOCUMENT_DIGEST_MISMATCH',
          'Stored bytes differ from the selected document content identity',
        );
      return { name: document.name, mimeType, buffer };
    } finally {
      await handle.close();
    }
  }
}
