import { describe, expect, it, vi } from 'vitest';
import { ApplicationSchemaSchema } from './inspection.js';
import {
  ApplicationProfileSchema,
  PreparedApplicationSchema,
} from './preparation.js';
import {
  classifyField,
  classifyQuestion,
  KeywordEvidenceRetriever,
  MockAnswerGenerationProvider,
  PreparationEngine,
} from './preparation-engine.js';
import type { AnswerGenerationProvider } from './preparation-engine.js';

const field = (
  id: string,
  label: string,
  type = 'TEXT',
  maxLength?: number,
) => ({
  id,
  label,
  type,
  required: true,
  visible: true,
  disabled: false,
  readonly: false,
  options: [],
  source: 'DOM',
  ...(maxLength ? { maxLength } : {}),
});
const base = () => {
  const fields = [
    field('first', 'Given name'),
    field('last', 'Surname'),
    field('email', 'Candidate email', 'EMAIL'),
    field('phone', 'Mobile'),
    field('linkedin', 'LinkedIn URL'),
    field('github', 'GitHub profile'),
    field('portfolio', 'Portfolio'),
    field('college', 'University'),
    field('degree', 'Degree'),
    field('cgpa', 'CGPA'),
    field('resume', 'Resume', 'FILE'),
    field('motivation', 'Why do you want to work here?', 'TEXTAREA', 500),
    field('project', 'Describe a challenging project.', 'TEXTAREA', 500),
    field('sponsorship', 'Will you require sponsorship?'),
    field('salary', 'Expected salary?'),
  ];
  const questions = ['motivation', 'project', 'sponsorship', 'salary'].map(
    (id) => ({
      id,
      fieldId: id,
      text: fields.find((f) => f.id === id)!.label,
      type: id === 'project' || id === 'motivation' ? 'TEXTAREA' : 'TEXT',
      required: true,
      sensitivity:
        id === 'salary' || id === 'sponsorship' ? 'CONSEQUENTIAL' : 'NONE',
      semanticType: 'CUSTOM_QUESTION',
      answerSource: 'UNRESOLVED',
      humanReviewRequired: false,
    }),
  );
  return {
    applicationId: 'app',
    inspectionId: 'inspection',
    job: {
      id: 'job',
      externalId: 'external',
      source: 'test',
      company: 'Example',
      title: 'Backend Engineer',
      description: 'Build Node.js services',
      requirements: ['Node.js'],
    },
    schema: ApplicationSchemaSchema.parse({
      inspectionId: 'inspection',
      applicationPlanId: 'plan',
      sourceUrl: 'https://example.com/apply',
      finalUrl: 'https://example.com/apply',
      redirectChain: [],
      finalHostname: 'example.com',
      plannedApplicationType: 'DIRECT_PORTAL',
      platform: 'GENERIC_PORTAL',
      platformDiscrepancy: false,
      title: 'Apply',
      fields,
      questions,
      documents: [
        {
          type: 'RESUME',
          label: 'Resume',
          required: true,
          fieldId: 'resume',
          acceptedFileTypes: ['.pdf'],
          humanReviewRequired: false,
        },
      ],
      forms: [],
      authentication: { required: false },
      humanReview: { required: false, reasons: [] },
      confidence: 0.9,
      inspectionMetadata: {
        inspectedAt: new Date().toISOString(),
        durationMs: 1,
        visibleTextExcerpt: 'Apply',
        fieldCount: fields.length,
      },
    }),
    email: 'ada@example.com',
    profile: ApplicationProfileSchema.parse({
      firstName: 'Ada',
      lastName: 'Lovelace',
      phone: '12345',
      linkedin: 'https://linkedin.com/in/ada',
      github: 'https://github.com/ada',
      portfolio: 'https://ada.example',
      college: 'Example University',
      degree: 'BSc',
      cgpa: '9.2',
      projects: [
        {
          id: 'sports',
          category: 'PROJECT',
          text: 'Built SportsTalk using Node.js, PostgreSQL and Socket.io for real-time sports communities.',
          tags: ['Node.js', 'PostgreSQL', 'real-time'],
        },
        {
          id: 'brain',
          category: 'PROJECT',
          text: 'Built Company Brain with Python.',
          tags: ['Python'],
        },
      ],
    }),
    documents: [
      {
        id: 'resume-doc',
        type: 'RESUME',
        name: 'resume.pdf',
        storageRef: 'object://resume',
        mimeType: 'application/pdf',
        size: 100,
        metadata: {},
      },
    ],
    verifiedAnswers: [
      {
        id: 'verified',
        category: 'SPONSORSHIP',
        value: 'No',
        source: 'USER_VERIFIED',
        verifiedAt: new Date().toISOString(),
      },
    ],
  } as const;
};

describe('Phase 3 preparation', () => {
  it('batches unresolved fields and custom/sensitive questions and retains low confidence proposals for review', async () => {
    const input = base();
    input.schema.fields.push(field('company-name', 'Company name'));
    input.profile.experience.push({
      id: 'employer',
      category: 'EXPERIENCE',
      company: 'Example',
      text: 'Worked at Example.',
      tags: [],
    });
    const generateAnswers = vi.fn(async (batch) => ({
      answers: batch.questions.map((question: { id: string }) => ({
        id: question.id,
        answer:
          question.id === 'company-name' ? 'Example' : 'Built SportsTalk.',
        confidence: question.id === 'project' ? 0.74 : 0.9,
        supportedBySavedInformation: true,
        conflictingInformation: false,
        requiresHumanReview: question.id === 'salary',
        evidence:
          question.id === 'company-name'
            ? [{ evidenceId: 'profile:experience:0', quote: 'Example' }]
            : [{ evidenceId: 'profile:projects:0', quote: 'SportsTalk' }],
        explanation: 'Uses saved project evidence.',
      })),
    }));
    const ai: AnswerGenerationProvider = {
      name: 'controlled',
      generateAnswers,
      generateAnswer: async () => {
        throw new Error('No per-question calls');
      },
    };
    const result = await new PreparationEngine(ai).prepare(input as never);
    expect(generateAnswers).toHaveBeenCalledTimes(1);
    expect(
      result.fields.find((field) => field.fieldId === 'company-name'),
    ).toMatchObject({
      value: 'Example',
      source: 'LLM_GENERATED',
      requiresHumanReview: false,
      aiApproval: { threshold: 0.75 },
    });
    expect(
      result.questions.find((question) => question.questionId === 'project'),
    ).toMatchObject({
      answer: 'Built SportsTalk.',
      confidence: 0.74,
      requiresHumanReview: true,
    });
    expect(
      result.humanReviewItems.some((item) => item.requirementId === 'project'),
    ).toBe(true);
    expect(
      result.questions.find((question) => question.questionId === 'sponsorship')
        ?.source,
    ).toBe('USER_VERIFIED');
  });
  it('classifies label variants and sensitive questions deterministically', () => {
    for (const [label, expected] of [
      ['First name', 'FIRST_NAME'],
      ['Candidate first name', 'FIRST_NAME'],
      ['Family name', 'LAST_NAME'],
      ['Email address', 'EMAIL'],
      ['Phone number', 'PHONE'],
      ['GitHub URL', 'GITHUB'],
    ])
      expect(classifyField(field('x', label) as never).semanticType).toBe(
        expected,
      );
    expect(
      classifyField(field('x', 'Other details') as never).semanticType,
    ).toBe('UNKNOWN');
    for (const [text, expected] of [
      ['Why are you interested in this role?', 'ROLE_MOTIVATION'],
      ['Tell us about yourself.', 'SELF_INTRODUCTION'],
      ['Describe a challenging project.', 'PROJECT_EXPERIENCE'],
      ['Tell us about your backend experience.', 'TECHNICAL_EXPERIENCE'],
      ['What is your greatest achievement?', 'ACHIEVEMENT'],
      ['Why should we hire you?', 'SELF_PITCH'],
      ['Do you have security clearance?', 'SECURITY_CLEARANCE'],
      ['Have you been convicted?', 'LEGAL_DECLARATION'],
    ])
      expect(classifyQuestion(text)).toBe(expected);
  });
  it('resolves profile, document, evidence-backed answers, verified sponsorship and salary review', async () => {
    const result = await new PreparationEngine(
      new MockAnswerGenerationProvider(),
    ).prepare(base() as never);
    expect(PreparedApplicationSchema.parse(result)).toEqual(result);
    expect(result.fields.map((f) => f.value)).toEqual([
      'Ada',
      'Lovelace',
      'ada@example.com',
      '12345',
      'https://linkedin.com/in/ada',
      'https://github.com/ada',
      'https://ada.example',
      'Example University',
      'BSc',
      '9.2',
    ]);
    expect(result.documents[0]?.documentId).toBe('resume-doc');
    expect(
      result.questions.find((q) => q.questionId === 'project')?.evidenceIds,
    ).toContain('sports');
    expect(
      result.questions.find((q) => q.questionId === 'sponsorship'),
    ).toMatchObject({ source: 'USER_VERIFIED', answer: 'No' });
    expect(
      result.questions.find((q) => q.questionId === 'salary'),
    ).toMatchObject({ source: 'HUMAN_REQUIRED', answer: null });
    expect(result.overallStatus).toBe('HUMAN_REQUIRED');
  });
  it('selects the relevant project and never invents missing evidence', async () => {
    const input = base();
    expect(
      new KeywordEvidenceRetriever().retrieve(
        'Describe a real-time Node.js project',
        'PROJECT_EXPERIENCE',
        input.profile,
        input.job,
      )[0]?.id,
    ).toBe('sports');
    const result = await new PreparationEngine(
      new MockAnswerGenerationProvider(),
    ).prepare({
      ...input,
      profile: ApplicationProfileSchema.parse({}),
    } as never);
    expect(
      result.questions.find((q) => q.questionId === 'project')
        ?.requiresHumanReview,
    ).toBe(true);
  });
  it.each([
    'invalid JSON',
    'schema mismatch',
    'provider failure',
    'empty answer',
    'unsupported answer',
  ])('routes %s to review', async (failure) => {
    const provider: AnswerGenerationProvider = {
      name: 'failure',
      generateAnswer: async () => {
        if (failure === 'provider failure') throw new Error('timeout');
        if (failure === 'invalid JSON') return '{';
        if (failure === 'schema mismatch') return { answer: 'x' };
        if (failure === 'empty answer')
          return {
            answer: '',
            category: 'MOTIVATION',
            evidenceIds: ['sports'],
            requiresHumanReview: false,
            reasoningSummary: '',
          };
        return {
          answer: 'Unsupported',
          category: 'MOTIVATION',
          evidenceIds: ['invented'],
          requiresHumanReview: false,
          reasoningSummary: '',
        };
      },
    };
    const result = await new PreparationEngine(provider).prepare(
      base() as never,
    );
    expect(
      result.questions.find((q) => q.questionId === 'motivation')
        ?.requiresHumanReview,
    ).toBe(true);
  });
  it('rejects answers beyond character limits without blind truncation', async () => {
    const input = base();
    input.schema.fields.find((f) => f.id === 'project')!.maxLength = 5;
    const result = await new PreparationEngine(
      new MockAnswerGenerationProvider(),
    ).prepare(input as never);
    expect(
      result.questions.find((q) => q.questionId === 'project'),
    ).toMatchObject({ answer: null, requiresHumanReview: true });
  });
  it.each([
    ['sponsorship', 'Will you require sponsorship?', 'SPONSORSHIP'],
    ['salary', 'What is your expected salary?', 'SALARY'],
    [
      'authorization',
      'Are you legally authorized to work?',
      'WORK_AUTHORIZATION',
    ],
    ['clearance', 'Do you have security clearance?', 'SECURITY_CLEARANCE'],
    ['legal', 'Have you been convicted of a crime?', 'LEGAL_DECLARATION'],
  ])('requires a verified answer for %s', async (id, prompt, category) => {
    const input = base();
    input.schema.questions = [
      {
        id,
        fieldId: id,
        text: prompt,
        type: 'TEXT',
        required: true,
        sensitivity: 'CONSEQUENTIAL',
        semanticType: 'CUSTOM_QUESTION',
        answerSource: 'UNRESOLVED',
        humanReviewRequired: true,
      },
    ];
    input.schema.fields.push(field(id, prompt) as never);
    const result = await new PreparationEngine(
      new MockAnswerGenerationProvider(),
    ).prepare({ ...input, verifiedAnswers: [] } as never);
    expect(result.questions[0]).toMatchObject({
      category,
      answer: null,
      source: 'HUMAN_REQUIRED',
      requiresHumanReview: true,
    });
  });
  it('selects available documents and records missing required ones', async () => {
    const input = base();
    input.schema.documents.push({
      type: 'COVER_LETTER',
      label: 'Cover letter',
      required: true,
      fieldId: 'cover',
      acceptedFileTypes: ['.pdf'],
      humanReviewRequired: false,
    });
    input.schema.documents.push({
      type: 'PORTFOLIO',
      label: 'Portfolio',
      required: true,
      fieldId: 'portfolio-file',
      acceptedFileTypes: [],
      humanReviewRequired: false,
    });
    const result = await new PreparationEngine(
      new MockAnswerGenerationProvider(),
    ).prepare(input as never);
    expect(result.documents.map((d) => d.documentId)).toEqual([
      'resume-doc',
      null,
      null,
    ]);
    expect(result.humanReviewItems.map((item) => item.requirementId)).toContain(
      'cover',
    );
  });
  it('never invokes a browser or external action', async () => {
    const fetch = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => {
      throw new Error('External request forbidden');
    });
    const provider = new MockAnswerGenerationProvider();
    try {
      const result = await new PreparationEngine(provider).prepare(
        base() as never,
      );
      expect(result.applicationId).toBe('app');
      expect(fetch).not.toHaveBeenCalled();
    } finally {
      fetch.mockRestore();
    }
  });
});
