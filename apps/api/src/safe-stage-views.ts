import {
  ApplicationSchemaSchema,
  ExecutionResultSchema,
  PreparedApplicationSchema,
} from '@careerlift/domain';
export function safePreparation(raw: unknown) {
  const parsed = PreparedApplicationSchema.safeParse(raw);
  if (!parsed.success) return null;
  const result = parsed.data;
  return {
    applicationId: result.applicationId,
    overallStatus: result.overallStatus,
    preparedAt: result.preparedAt,
    fieldCount: result.fields.length,
    answerCount: result.questions.length,
    reviewCount: result.humanReviewItems.length,
    documents: result.documents.map((d) => ({
      type: d.documentType,
      selected: !!d.documentId,
    })),
  };
}
export function safeInspection(raw: unknown) {
  const parsed = ApplicationSchemaSchema.safeParse(raw);
  if (!parsed.success) return null;
  const schema = parsed.data;
  return {
    title: schema.title,
    fields: schema.fields.map((f) => ({
      id: f.id,
      label: f.label,
      type: f.type,
      required: f.required,
      options: f.options,
    })),
    questions: schema.questions.map((q) => ({
      id: q.id,
      fieldId: q.fieldId,
      text: q.text,
      type: q.type,
      required: q.required,
      sensitivity: q.sensitivity,
    })),
    documents: schema.documents.map((d) => ({
      fieldId: d.fieldId,
      type: d.type,
      label: d.label,
      required: d.required,
      acceptedFileTypes: d.acceptedFileTypes,
    })),
    humanReview: schema.humanReview,
  };
}
export function safeExecution(raw: unknown) {
  const parsed = ExecutionResultSchema.safeParse(raw);
  if (!parsed.success) return null;
  return {
    status: parsed.data.status,
    mode: parsed.data.mode,
    canResume:
      parsed.data.status === 'PAUSED_HUMAN_REQUIRED' &&
      parsed.data.checkpoint?.resumable === true &&
      !parsed.data.checkpoint.unsafeActionStarted,
    humanReviewRequired:
      parsed.data.status === 'PAUSED_HUMAN_REQUIRED' ||
      parsed.data.status === 'BLOCKED',
  };
}
export function executionBlocker(raw: unknown) {
  const parsed = ExecutionResultSchema.safeParse(raw);
  const code = parsed.success
    ? parsed.data.humanReviewItems[0]?.reason
    : undefined;
  if (code === 'CAPTCHA')
    return {
      type: 'CAPTCHA',
      reason: 'A CAPTCHA appeared during execution. The agent is paused.',
    };
  if (code === 'AUTHENTICATION_REQUIRED')
    return {
      type: 'AUTHENTICATION_REQUIRED',
      reason:
        'The application platform requires authentication. The agent is paused.',
    };
  if (code === 'SECURITY_INSPECTION_INCOMPLETE')
    return {
      type: 'SECURITY_CHALLENGE',
      reason: 'Security checks could not complete safely. The agent is paused.',
    };
  return {
    type: 'OTHER_EXECUTION_BLOCKER',
    reason:
      'The application form or a required control changed during execution. The agent stopped for review.',
  };
}
export function safeVerification(record: {
  id: string;
  state: string;
  establishedState: string | null;
  createdAt: Date;
  updatedAt: Date;
}) {
  return {
    id: record.id,
    state: record.state,
    establishedState: record.establishedState,
    createdAt: record.createdAt.toISOString(),
    updatedAt: record.updatedAt.toISOString(),
  };
}
