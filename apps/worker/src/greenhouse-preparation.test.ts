import { describe, expect, it, vi } from 'vitest';
import type { PrismaClient } from '@careerlift/database';
import type { Queue } from 'bullmq';
import {
  ApplicationProfileSchema,
  PreparationEngine,
  type AnswerGenerationProvider,
} from '@careerlift/domain';
import { greenhouseInput } from '../../../packages/browser/src/test-support/greenhouse-fixture.js';
import {
  requestGreenhousePreparation,
  recoverGreenhousePreparations,
} from './greenhouse-preparation.js';

function setup() {
  const input = greenhouseInput('https://127.0.0.1:1234');
  const record = {
    id: 'application',
    state: 'RESOLVED',
    plan: input.plan,
    inspection: {
      id: 'inspection',
      applicationPlanId: 'plan',
      state: 'HUMAN_REQUIRED',
      result: {
        ...input.inspection,
        humanReview: { required: true, reasons: ['SENSITIVE_QUESTION'] },
      },
    },
    preparation: null as { state: string; inspectionId: string } | null,
    executions: [] as { id: string }[],
  };
  const upsert = vi.fn(async () => ({
      id: 'preparation',
      state: 'PENDING',
      inspectionId: 'inspection',
      version: 1,
    })),
    add = vi.fn();
  const db = {
    application: {
      findUnique: async () => record,
      findMany: vi.fn(async () => [{ id: 'application' }]),
    },
    applicationPreparation: { upsert },
  } as unknown as PrismaClient;
  return { input, record, db, queue: { add } as unknown as Queue, upsert, add };
}
describe('Greenhouse answer preparation', () => {
  it('schedules the shared answer stage after a sensitive-question inspection with a stable queue identity', async () => {
    const f = setup();
    await requestGreenhousePreparation(f.db, f.queue, 'application');
    await requestGreenhousePreparation(f.db, f.queue, 'application');
    expect(f.add).toHaveBeenCalledWith(
      'PREPARE_APPLICATION',
      expect.objectContaining({ applicationId: 'application' }),
      expect.objectContaining({ jobId: 'prepare-greenhouse-preparation-1' }),
    );
    expect(f.add.mock.calls[0]).toEqual(f.add.mock.calls[1]);
  });
  it.each([
    'CAPTCHA',
    'AUTHENTICATION_REQUIRED',
    'UNEXPECTED_NAVIGATION',
    'PLATFORM_MISMATCH',
  ])('does not prepare an inspection gated by %s', async (reason) => {
    const f = setup();
    f.record.inspection.result.humanReview.reasons.push(reason);
    await requestGreenhousePreparation(f.db, f.queue, 'application');
    expect(f.upsert).not.toHaveBeenCalled();
    expect(f.add).not.toHaveBeenCalled();
  });
  it.each(['RUNNING', 'HUMAN_REQUIRED', 'COMPLETED', 'FAILED'])(
    'preserves %s preparation and candidate decisions',
    async (state) => {
      const f = setup();
      f.record.preparation = { state, inspectionId: 'inspection' };
      await requestGreenhousePreparation(f.db, f.queue, 'application');
      expect(f.add).not.toHaveBeenCalled();
      expect(f.upsert).not.toHaveBeenCalled();
    },
  );
  it('does not prepare an application with an execution already recorded', async () => {
    const f = setup();
    f.record.executions.push({ id: 'execution' });
    await requestGreenhousePreparation(f.db, f.queue, 'application');
    expect(f.add).not.toHaveBeenCalled();
  });
  it('recovers previously inspected applications and retries queue failures without losing the inspection', async () => {
    const f = setup();
    f.add.mockRejectedValueOnce(new Error('Queue unavailable'));
    await recoverGreenhousePreparations(f.db, f.queue);
    await recoverGreenhousePreparations(f.db, f.queue);
    expect(f.add).toHaveBeenCalledTimes(2);
    expect(f.record.inspection.state).toBe('HUMAN_REQUIRED');
  });
  it('sends the full profile and selected resume to the shared LLM and reviews low-confidence, missing, and invalid dropdown answers', async () => {
    const f = setup(),
      schema = f.input.inspection;
    const control = schema.fields.find((f) => f.domId === 'question_1')!;
    const baseQuestion = schema.questions[0]!;
    for (const [index, text] of [
      'Experience range?',
      'Expected compensation?',
      'Previous interview?',
    ].entries()) {
      const id = `extra-${index}`;
      schema.fields.push({ ...control, id, domId: id, label: text });
      schema.questions.push({ ...baseQuestion, id, fieldId: id, text });
    }
    const generateAnswers = vi.fn(async () => ({
      answers: [
        {
          id: 'q1',
          answer: 'Yes',
          confidence: 0.9,
          supportedBySavedInformation: true,
          conflictingInformation: false,
          requiresHumanReview: false,
          evidence: [
            {
              evidenceId: 'profile:summary',
              quote: 'Available for the internship',
            },
          ],
          explanation: 'Saved availability',
        },
        {
          id: 'extra-0',
          answer: 'Yes',
          confidence: 0.79,
          supportedBySavedInformation: true,
          conflictingInformation: false,
          requiresHumanReview: false,
          evidence: [
            { evidenceId: 'resume:resume:0', quote: 'React experience' },
          ],
          explanation: 'Tentative',
        },
        {
          id: 'extra-1',
          answer: null,
          confidence: 0,
          supportedBySavedInformation: false,
          conflictingInformation: false,
          requiresHumanReview: true,
          evidence: [],
          explanation: 'Missing salary preference',
        },
        {
          id: 'extra-2',
          answer: 'Maybe',
          confidence: 0.99,
          supportedBySavedInformation: true,
          conflictingInformation: false,
          requiresHumanReview: false,
          evidence: [
            {
              evidenceId: 'profile:summary',
              quote: 'Available for the internship',
            },
          ],
          explanation: 'Invalid option',
        },
      ],
    }));
    const provider: AnswerGenerationProvider = {
      name: 'controlled',
      generateAnswers,
      generateAnswer: async () => {
        throw new Error('Unexpected legacy answer call');
      },
    };
    const profile = ApplicationProfileSchema.parse({
      firstName: 'Ada',
      country: 'India',
      summary: 'Available for the internship',
    });
    const resumeContext = {
      documentId: 'resume',
      name: 'resume.pdf',
      text: 'React experience',
      status: 'READY' as const,
    };
    const result = await new PreparationEngine(
      provider,
      undefined,
      0.8,
    ).prepare({
      applicationId: 'application',
      inspectionId: 'inspection',
      schema,
      job: {
        id: 'job',
        externalId: 'job',
        source: 'TEST',
        company: 'Fixture',
        title: 'Frontend engineer',
        requirements: [],
      },
      email: 'ada@example.com',
      profile,
      documents: f.input.documents,
      verifiedAnswers: [],
      resumeContext,
    });
    expect(generateAnswers).toHaveBeenCalledTimes(1);
    expect(generateAnswers).toHaveBeenCalledWith(
      expect.objectContaining({
        profile,
        resume: resumeContext,
        questions: expect.arrayContaining([
          expect.objectContaining({ id: 'q1', options: ['Yes', 'No'] }),
        ]),
      }),
    );
    expect(result.questions.find((q) => q.questionId === 'q1')).toMatchObject({
      answer: 'Yes',
      source: 'LLM_GENERATED',
      requiresHumanReview: false,
      aiApproval: { threshold: 0.8 },
    });
    expect(
      result.questions.find((q) => q.questionId === 'extra-0'),
    ).toMatchObject({
      answer: 'Yes',
      confidence: 0.79,
      requiresHumanReview: true,
    });
    expect(
      result.questions.find((q) => q.questionId === 'extra-1'),
    ).toMatchObject({ answer: null, requiresHumanReview: true });
    expect(
      result.questions.find((q) => q.questionId === 'extra-2'),
    ).toMatchObject({ answer: null, requiresHumanReview: true });
    expect(result.humanReviewItems.map((i) => i.requirementId)).toEqual(
      expect.arrayContaining(['extra-0', 'extra-1', 'extra-2']),
    );
  });
});
