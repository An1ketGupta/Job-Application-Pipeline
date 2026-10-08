import { createHash } from 'node:crypto';
import type { ExecutionInput } from '@careerlift/domain';
import { InspectionError } from './policy.js';

export const digest = (bytes: string | Uint8Array) =>
  createHash('sha256').update(bytes).digest('hex');
export type RequestField =
  | {
      name: string;
      kind: 'STATIC_APPROVED_FIELD' | 'DYNAMIC_APPROVED_FIELD';
      value: string;
    }
  | {
      name: string;
      kind: 'DOCUMENT';
      documentId: string;
      fileName: string;
      mimeType: string;
      size: number;
      sha256: string;
    };
export type MutationContract = {
  applicationId: string;
  executionId: string;
  userId: string;
  runId: string;
  generation: number;
  actionId: string;
  action: 'NEXT' | 'FINAL_SUBMIT';
  destination: string;
  method: string;
  externalIdentity: {
    canonicalApplicationUrl: string;
    jobFields: { name: string; value: string }[];
  };
  fields: RequestField[];
};
const orderedFields = (fields: RequestField[]) =>
  fields
    .map((f) =>
      f.kind === 'DOCUMENT'
        ? {
            name: f.name,
            kind: f.kind,
            documentId: f.documentId,
            fileName: f.fileName,
            mimeType: f.mimeType,
            size: f.size,
            sha256: f.sha256,
          }
        : { name: f.name, kind: f.kind, value: f.value },
    )
    .sort((a, b) =>
      a.name < b.name
        ? -1
        : a.name > b.name
          ? 1
          : JSON.stringify(a) < JSON.stringify(b)
            ? -1
            : JSON.stringify(a) > JSON.stringify(b)
              ? 1
              : 0,
    );
export function canonicalContract(contract: MutationContract) {
  // Explicit property order; no object insertion order or multipart boundary dependency.
  return JSON.stringify({
    applicationId: contract.applicationId,
    executionId: contract.executionId,
    userId: contract.userId,
    runId: contract.runId,
    generation: contract.generation,
    actionId: contract.actionId,
    action: contract.action,
    destination: contract.destination,
    method: contract.method,
    externalIdentity: {
      canonicalApplicationUrl:
        contract.externalIdentity.canonicalApplicationUrl,
      jobFields: contract.externalIdentity.jobFields
        .map((f) => ({ name: f.name, value: f.value }))
        .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0)),
    },
    fields: orderedFields(contract.fields),
  });
}
export const contractDigest = (contract: MutationContract) =>
  digest(canonicalContract(contract));
export function bindContract(
  input: ExecutionInput,
  stepId: string,
  action: MutationContract['action'],
  destination: string,
  method: string,
  fields: RequestField[],
): MutationContract {
  const identity = input.dispatchIdentity ?? {
    userId: input.ownerId ?? 'LOCAL_FIXTURE',
    runId: input.executionId,
    generation: 1,
  };
  if (input.mode === 'REAL_EXECUTION' && !input.dispatchIdentity)
    throw new InspectionError(
      'DISPATCH_IDENTITY_REQUIRED',
      'Production dispatch requires worker identity',
    );
  return {
    applicationId: input.applicationId,
    executionId: input.executionId,
    ...identity,
    actionId: stepId,
    action,
    destination,
    method,
    externalIdentity: {
      canonicalApplicationUrl: input.inspection.finalUrl,
      jobFields: fields
        .filter(
          (f): f is Extract<RequestField, { value: string }> =>
            f.kind !== 'DOCUMENT' &&
            /^(?:job_?id|posting_?id|requisition_?id)$/i.test(f.name),
        )
        .map((f) => ({ name: f.name, value: f.value })),
    },
    fields: orderedFields(fields),
  };
}

export async function validatePayload(
  contract: MutationContract,
  body: Buffer,
  contentType: string,
) {
  if (body.length > 50 * 1024 * 1024)
    throw new InspectionError(
      'MUTATION_BODY_TOO_LARGE',
      'Mutation payload too large',
    );
  if (
    !/^(multipart\/form-data|application\/x-www-form-urlencoded)(?:;|$)/i.test(
      contentType,
    )
  )
    throw new InspectionError(
      'UNSUPPORTED_MUTATION_ENCODING',
      'An explicit form request contract is required',
    );
  let data: FormData;
  try {
    data = await new Request('https://payload.invalid', {
      method: 'POST',
      headers: { 'content-type': contentType },
      body: new Uint8Array(body),
    }).formData();
  } catch {
    throw new InspectionError(
      'INVALID_MUTATION_PAYLOAD',
      'Invalid serialized form',
    );
  }
  const actual: RequestField[] = [];
  const remaining = [...contract.fields];
  const entries: [string, FormDataEntryValue][] = [];
  data.forEach((value, name) => entries.push([name, value]));
  for (const [name, value] of entries) {
    const index = remaining.findIndex((f) => f.name === name);
    if (index < 0)
      throw new InspectionError(
        'UNEXPECTED_MUTATION_FIELD',
        'Unexpected or duplicate request field',
      );
    const expected = remaining.splice(index, 1)[0]!;
    if (typeof value === 'string') {
      if (expected.kind === 'DOCUMENT' || value !== expected.value)
        throw new InspectionError(
          'MUTATION_VALUE_MISMATCH',
          'Request value differs from approved value',
        );
      actual.push({ ...expected, value });
    } else {
      if (expected.kind !== 'DOCUMENT')
        throw new InspectionError(
          'UNEXPECTED_MUTATION_DOCUMENT',
          'Unapproved document',
        );
      const sha256 = digest(new Uint8Array(await value.arrayBuffer()));
      if (
        value.name !== expected.fileName ||
        value.type !== expected.mimeType ||
        value.size !== expected.size ||
        sha256 !== expected.sha256
      )
        throw new InspectionError(
          'MUTATION_DOCUMENT_MISMATCH',
          'Request document differs from approved bytes',
        );
      actual.push({ ...expected, sha256 });
    }
  }
  if (remaining.length)
    throw new InspectionError(
      'MISSING_MUTATION_FIELD',
      'Approved request field missing',
    );
  if (
    contractDigest({ ...contract, fields: actual }) !== contractDigest(contract)
  )
    throw new InspectionError(
      'MUTATION_CONTRACT_MISMATCH',
      'Canonical request differs',
    );
}
