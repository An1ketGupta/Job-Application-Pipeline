import { describe, expect, it, vi } from 'vitest';
import { ApplicationProfileSchema } from './preparation.js';
import {
  resolveCandidateAnswers,
  candidateEvidence,
  isAcceptedAiAnswer,
  type AnswerBatchInput,
} from './answer-pipeline.js';
import type { AnswerGenerationProvider } from './preparation-engine.js';

const context = () => ({
  questions: [
    {
      id: 'company',
      question: 'Previous company name',
      category: 'CUSTOM_QUESTION' as const,
      fieldType: 'TEXT',
      options: [],
    },
  ],
  profile: ApplicationProfileSchema.parse({
    fullName: 'Ada',
    experience: [
      {
        id: 'exp',
        category: 'EXPERIENCE',
        text: 'Engineer at Example since 2022.',
        company: 'Example',
        tags: [],
      },
    ],
  }),
  email: 'ada@example.com',
  resume: {
    documentId: 'resume',
    name: 'resume.txt',
    text: 'Engineer at Example since 2022.',
    status: 'READY' as const,
  },
  verifiedAnswers: [],
  job: { title: 'Engineer', company: 'Employer', requirements: [] },
});
const output = (id = 'company', confidence = 0.75) => ({
  id,
  answer: 'Example',
  confidence,
  supportedBySavedInformation: true,
  conflictingInformation: false,
  requiresHumanReview: false,
  evidence: [{ evidenceId: 'profile:experience:0', quote: 'Example' }],
  explanation: 'Company is explicitly saved.',
});
const provider = (answers: unknown[]): AnswerGenerationProvider => ({
  name: 'controlled',
  generateAnswer: async () => {
    throw new Error('Single calls forbidden');
  },
  generateAnswers: vi.fn(async () => ({ answers })),
});

describe('shared candidate answer pipeline', () => {
  it('accepts exactly 75%, reviews 74%, and sends full profile, resume and all questions in one call', async () => {
    const input = context();
    input.questions.push({ ...input.questions[0]!, id: 'second' });
    const ai = provider([output(), output('second', 0.74)]);
    const result = await resolveCandidateAnswers(input, ai);
    expect(result[0]).toMatchObject({
      answer: 'Example',
      confidence: 0.75,
      requiresHumanReview: false,
      approval: { threshold: 0.75 },
    });
    expect(result[1]).toMatchObject({
      answer: 'Example',
      confidence: 0.74,
      requiresHumanReview: true,
    });
    expect(ai.generateAnswers).toHaveBeenCalledTimes(1);
    const sent = vi.mocked(ai.generateAnswers!).mock.calls[0]![0];
    expect(sent.profile).toEqual(input.profile);
    expect(sent.resume.text).toBe(input.resume.text);
    expect(sent.questions).toHaveLength(2);
    expect(sent.evidence).toContainEqual({
      id: 'resume:resume:0',
      text: input.resume.text,
    });
  });
  it.each([
    'conflict',
    'unsupported',
    'invalid citation',
    'review requested',
    'unreadable resume',
    'invalid field',
  ])('requires review for %s even at 99%', async (reason) => {
    const value = output('company', 0.99),
      input = context();
    if (reason === 'conflict') value.conflictingInformation = true;
    if (reason === 'unsupported') value.supportedBySavedInformation = false;
    if (reason === 'invalid citation')
      value.evidence[0]!.quote = 'Invented Corp';
    if (reason === 'review requested') value.requiresHumanReview = true;
    if (reason === 'unreadable resume')
      input.resume.status = 'UNREADABLE' as never;
    const [result] = await resolveCandidateAnswers(
      input,
      provider([value]),
      0.75,
      () => reason !== 'invalid field',
    );
    expect(result?.requiresHumanReview).toBe(true);
    expect(result?.approval).toBeUndefined();
  });
  it('accepts sensitive answers supported by explicitly saved information', async () => {
    const input = context();
    input.questions[0]!.category = 'WORK_AUTHORIZATION' as never;
    input.verifiedAnswers = [
      {
        id: 'eligibility',
        category: 'WORK_AUTHORIZATION',
        question: 'Eligible to work?',
        value: 'Yes',
        source: 'USER_VERIFIED',
        verifiedAt: new Date().toISOString(),
      },
    ] as never;
    const value = {
      ...output(),
      answer: 'Yes',
      evidence: [{ evidenceId: 'verified:eligibility', quote: 'Yes' }],
    };
    expect(
      (await resolveCandidateAnswers(input, provider([value])))[0]
        ?.requiresHumanReview,
    ).toBe(false);
  });
  it('isolates invalid and duplicate answers and preserves valid ones', async () => {
    const input = context();
    input.questions.push({ ...input.questions[0]!, id: 'second' });
    expect(
      (
        await resolveCandidateAnswers(
          input,
          provider([output(), { id: 'second', confidence: 100 }]),
        )
      ).map((answer) => answer.requiresHumanReview),
    ).toEqual([false, true]);
    expect(
      (
        await resolveCandidateAnswers(context(), provider([output(), output()]))
      )[0]?.requiresHumanReview,
    ).toBe(true);
  });
  it('falls back to human review on provider failure, missing answers or invalid thresholds', async () => {
    const ai = provider([]);
    ai.generateAnswers = async () => {
      throw new Error('timeout');
    };
    expect((await resolveCandidateAnswers(context(), ai))[0]).toMatchObject({
      answer: null,
      requiresHumanReview: true,
    });
    await expect(resolveCandidateAnswers(context(), ai, 75)).rejects.toThrow(
      'INVALID_ANSWER_CONFIDENCE_THRESHOLD',
    );
  });
  it('does not let a confidence score alone clear execution review', () => {
    const answer = {
      source: 'LLM_GENERATED',
      confidence: 0.99,
      requiresHumanReview: false,
    };
    expect(isAcceptedAiAnswer(answer)).toBe(false);
    expect(
      isAcceptedAiAnswer({
        ...answer,
        aiApproval: { threshold: 0.75, evidenceIds: ['profile:experience:0'] },
      }),
    ).toBe(true);
    expect(
      isAcceptedAiAnswer({
        ...answer,
        confidence: 0.74,
        aiApproval: { threshold: 0.75, evidenceIds: ['profile:experience:0'] },
      }),
    ).toBe(false);
  });
  it('keeps complete profile sections available as evidence', () => {
    const evidence = candidateEvidence(
      context() as Omit<AnswerBatchInput, 'evidence'>,
    );
    expect(
      evidence.find((item) => item.id === 'profile:experience:0')?.text,
    ).toContain('company');
  });
});
