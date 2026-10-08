import { describe, expect, it, vi } from 'vitest';
import {
  candidateInput,
  candidateSchema,
} from '../../../tests/support/candidate-fixture.js';
import { ApplicationProfileSchema, questionKey } from './preparation.js';
import {
  PreparationEngine,
  classifyQuestion,
  canPrepareInspection,
} from './preparation-engine.js';

describe('Phase 8 candidate preparation safety', () => {
  it('uses live candidate data and exact user answers without promoting generation to verified', async () => {
    const input = candidateInput();
    input.verifiedAnswers = [
      {
        id: 'verified-react',
        category: 'CUSTOM_QUESTION',
        questionKey: questionKey('Years of experience with React?'),
        value: '2',
        source: 'USER_VERIFIED',
        verifiedAt: new Date().toISOString(),
      },
    ];
    const provider = { name: 'unsafe-generation', generateAnswer: vi.fn() };
    const result = await new PreparationEngine(provider).prepare(input);
    expect(result.fields.find((f) => f.fieldId === 'email')?.value).toBe(
      'applications@example.com',
    );
    expect(result.questions.find((q) => q.questionId === 'react')?.source).toBe(
      'USER_VERIFIED',
    );
    expect(
      result.questions.find((q) => q.questionId === 'sponsorship')?.answer,
    ).toBeNull();
    expect(result.humanReviewItems).toHaveLength(1);
    expect(provider.generateAnswer).not.toHaveBeenCalled();
  });
  it.each([
    'Are you willing to relocate?',
    'Do you have a disability?',
    'What is your ethnicity?',
    'Have you been convicted?',
    'What security clearance do you hold?',
    'What is your salary expectation?',
  ])('never generates a sensitive answer for %s', async (text) => {
    const input = candidateInput();
    input.schema.questions = [
      {
        ...input.schema.questions[0]!,
        id: 'sponsorship',
        text,
        semanticType: 'CUSTOM_QUESTION',
        sensitivity: 'NONE',
      },
    ];
    const provider = {
      name: 'unsafe',
      generateAnswer: vi.fn(async () => ({
        answer: 'Yes',
        category: classifyQuestion(text),
        requiresHumanReview: false,
        evidenceIds: ['react'],
        reasoningSummary: '',
      })),
    };
    const result = await new PreparationEngine(provider).prepare(input);
    expect(result.questions[0]?.answer).toBeNull();
    expect(result.humanReviewItems.length).toBeGreaterThan(0);
    expect(provider.generateAnswer).not.toHaveBeenCalled();
  });
  it('does not reuse an answer for a different technical or sensitive question, and flags conflicting exact answers', async () => {
    const input = candidateInput();
    input.verifiedAnswers = [
      {
        id: 'typescript',
        category: 'CUSTOM_QUESTION',
        questionKey: questionKey('Years of experience with TypeScript?'),
        value: '4',
        source: 'USER_VERIFIED',
        verifiedAt: new Date().toISOString(),
      },
    ];
    expect(
      (await new PreparationEngine().prepare(input)).questions.find(
        (q) => q.questionId === 'react',
      )?.answer,
    ).toBeNull();
    input.verifiedAnswers = ['Yes', 'No'].map((value, i) => ({
      id: `conflict-${i}`,
      category: 'SPONSORSHIP',
      questionKey: questionKey('Will you require sponsorship?'),
      value,
      source: 'USER_VERIFIED',
      verifiedAt: new Date().toISOString(),
    }));
    const result = await new PreparationEngine().prepare(input);
    expect(
      result.humanReviewItems.find((i) => i.requirementId === 'sponsorship')
        ?.reason,
    ).toBe('Conflicting verified answers');
  });
  it('validates user answers against constraints, requires explicit selection for ambiguous documents, and honors a single default', async () => {
    const input = candidateInput();
    input.documents.push({
      ...input.documents[0]!,
      id: 'second',
      name: 'second.pdf',
      metadata: {},
    });
    input.reviewDecisions = [
      {
        key: '00000000-0000-4000-8000-000000000001',
        actorId: 'owner',
        decidedAt: new Date().toISOString(),
        requirementId: 'sponsorship',
        action: 'ANSWER',
        value: 'Maybe',
      },
    ];
    let result = await new PreparationEngine().prepare(input);
    expect(result.documents[0]?.documentId).toBeNull();
    expect(result.questions[0]?.answer).toBeNull();
    input.documents[1]!.metadata.isDefault = true;
    input.reviewDecisions[0]!.value = 'No';
    result = await new PreparationEngine().prepare(input);
    expect(result.documents[0]?.documentId).toBe('second');
    expect(result.questions[0]?.source).toBe('USER_VERIFIED');
    input.reviewDecisions.push({
      key: '00000000-0000-4000-8000-000000000002',
      actorId: 'owner',
      decidedAt: new Date().toISOString(),
      requirementId: 'resume',
      action: 'SELECT_DOCUMENT',
      documentId: 'resume',
    });
    expect(
      (await new PreparationEngine().prepare(input)).documents[0]?.documentId,
    ).toBe('resume');
  });
  it('keeps a rejected proposal unresolved even when a saved answer exists', async () => {
    const input = candidateInput();
    input.verifiedAnswers = [
      {
        id: 'verified',
        category: 'SPONSORSHIP',
        value: 'No',
        source: 'USER_VERIFIED',
        verifiedAt: new Date().toISOString(),
      },
    ];
    input.reviewDecisions = [
      {
        key: '00000000-0000-4000-8000-000000000001',
        actorId: 'owner',
        decidedAt: new Date().toISOString(),
        requirementId: 'sponsorship',
        action: 'REJECT',
      },
    ];
    const result = await new PreparationEngine().prepare(input);
    expect(result.questions[0]?.answer).toBeNull();
    expect(
      result.humanReviewItems.find((i) => i.requirementId === 'sponsorship')
        ?.reason,
    ).toContain('rejected');
  });
  it('allows sensitive-only preparation while preserving CAPTCHA/authentication/interactive gates', () => {
    const schema = candidateSchema(
      'inspection',
      'plan',
      'https://example.com',
      true,
    );
    expect(canPrepareInspection('HUMAN_REQUIRED', schema)).toBe(true);
    for (const reason of [
      'CAPTCHA',
      'AUTHENTICATION_REQUIRED',
      'INTERACTIVE_DISCOVERY_REQUIRED',
    ] as const)
      expect(
        canPrepareInspection('HUMAN_REQUIRED', {
          ...schema,
          humanReview: {
            required: true,
            reasons: ['SENSITIVE_QUESTION', reason],
          },
        }),
      ).toBe(false);
    expect(
      canPrepareInspection('HUMAN_REQUIRED', {
        ...schema,
        authentication: { required: true },
      }),
    ).toBe(false);
  });
  it('rejects unsafe links, sensitive profile inference fields, duplicate entries, impossible dates, and reversed date ranges', () => {
    for (const data of [
      { linkedin: 'javascript:alert(1)' },
      { website: 'https://user:password@example.com' },
      { workAuthorization: 'Yes' },
      {
        skills: [
          { id: 'x', category: 'SKILL', text: 'React' },
          { id: 'x', category: 'SKILL', text: 'TS' },
        ],
      },
      {
        experience: [
          {
            id: 'x',
            category: 'EXPERIENCE',
            text: 'Engineer',
            startDate: '2026-02-30',
          },
        ],
      },
      {
        education: [
          {
            id: 'x',
            category: 'EDUCATION',
            text: 'Degree',
            startDate: '2026-10-10',
            endDate: '2025-01-01',
          },
        ],
      },
    ])
      expect(ApplicationProfileSchema.safeParse(data).success).toBe(false);
  });
});
