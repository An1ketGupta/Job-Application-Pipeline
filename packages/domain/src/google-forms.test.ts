import { describe, expect, it } from 'vitest';
import {
  ApplicationProfileSchema,
  type UserDocument,
  type VerifiedAnswer,
} from './preparation.js';
import {
  GoogleFormQuestionSchema,
  googleFormIdentity,
  prepareGoogleQuestions,
  validGoogleAnswer,
  type GoogleFormQuestion,
} from './google-forms.js';
const profile = ApplicationProfileSchema.parse({
  fullName: 'Ada Lovelace',
  email: 'ada@example.com',
  summary: 'I build TypeScript APIs.',
  skills: [
    {
      id: 'skill-1',
      category: 'SKILL',
      text: 'TypeScript',
      tags: ['TypeScript'],
    },
  ],
});
const job = {
  id: 'job',
  externalId: 'job',
  source: 'CAREERLIFT',
  title: 'Software Engineer',
  company: 'Example',
  requirements: [],
};
const question = (patch: Partial<GoogleFormQuestion> = {}) =>
  GoogleFormQuestionSchema.parse({
    id: 'entry.100',
    label: 'Full name',
    kind: 'TEXT',
    required: true,
    ...patch,
  });
const input = (questions: GoogleFormQuestion[]) => ({
  questions,
  profile,
  job,
  email: 'ada@example.com',
  documents: [],
  verified: [],
});
const document = (
  id: string,
  metadata: Record<string, unknown> = {},
): UserDocument => ({
  id,
  name: `${id}.pdf`,
  type: 'RESUME',
  storageRef: `local://${id}.pdf`,
  mimeType: 'application/pdf',
  size: 100,
  metadata,
});
describe('Google Forms candidate policies', () => {
  it('uses the shared batch threshold for selections and preserves proposals that need review', async () => {
    const questions = [
      question({
        id: 'high',
        label: 'Choose your skill',
        kind: 'SELECT',
        options: ['TypeScript', 'Python'],
      }),
      question({
        id: 'low',
        label: 'Describe how you handled a difficult challenge',
        kind: 'PARAGRAPH',
      }),
    ];
    const provider = {
      name: 'controlled',
      generateAnswer: async () => {
        throw new Error('No single calls');
      },
      generateAnswers: async () => ({
        answers: questions.map((question) => ({
          id: question.id,
          answer: 'TypeScript',
          confidence: question.id === 'high' ? 0.75 : 0.74,
          supportedBySavedInformation: true,
          conflictingInformation: false,
          requiresHumanReview: false,
          evidence: [{ evidenceId: 'profile:skills:0', quote: 'TypeScript' }],
          explanation: 'Explicit saved skill.',
        })),
      }),
    };
    const answers = await prepareGoogleQuestions({
      ...input(questions),
      provider,
      confidenceThreshold: 0.75,
    });
    expect(answers[0]).toMatchObject({
      value: 'TypeScript',
      source: 'AI',
      confidence: 0.75,
      review: null,
    });
    expect(answers[1]).toMatchObject({ value: 'TypeScript', confidence: 0.74 });
    expect(answers[1]?.review).toContain('below');
  });
  it('accepts only Google Forms URLs and short links with public canonical identities', () => {
    expect(
      googleFormIdentity(
        'https://docs.google.com/forms/d/e/PublishedForm123/viewform?usp=tracking',
      )?.url,
    ).toBe('https://docs.google.com/forms/d/e/PublishedForm123/viewform');
    expect(googleFormIdentity('https://forms.gle/abcdefgh')?.short).toBe(true);
    for (const url of [
      'https://docs.google.com/document/d/abcde/edit',
      'https://docs.google.com.evil.test/forms/d/abcde/viewform',
      'http://docs.google.com/forms/d/abcde/viewform',
      'https://user@docs.google.com/forms/d/abcde/viewform',
    ])
      expect(googleFormIdentity(url)).toBeUndefined();
  });
  it('uses profile facts and leaves unknown optional questions blank', async () => {
    const answers = await prepareGoogleQuestions(
      input([
        question(),
        question({
          id: 'entry.200',
          label: 'Favourite colour',
          required: false,
        }),
      ]),
    );
    expect(answers[0]).toMatchObject({
      value: 'Ada Lovelace',
      source: 'PROFILE',
      review: null,
    });
    expect(answers[1]).toMatchObject({
      value: null,
      source: 'SKIPPED',
      review: null,
    });
  });
  it('uses explicitly verified consequential answers and accepts a reviewed replacement', async () => {
    const q = question({ label: 'Expected salary' });
    const verified: VerifiedAnswer[] = [
      {
        id: 'saved',
        category: 'SALARY',
        questionKey: 'expected salary',
        value: '100000',
        source: 'USER_VERIFIED',
        verifiedAt: new Date().toISOString(),
      },
    ];
    const first = await prepareGoogleQuestions({ ...input([q]), verified });
    expect(first[0]?.value).toBe('100000');
    expect(first[0]?.review).toBeNull();
    const reviewed = await prepareGoogleQuestions({
      ...input([q]),
      verified,
      decisions: { [q.id]: '110000' },
    });
    expect(reviewed[0]).toMatchObject({
      value: '110000',
      source: 'REVIEW',
      review: null,
    });
    expect(
      (await prepareGoogleQuestions({ ...input([q]), verified }))[0]?.review,
    ).toBeNull();
  });
  it('never guesses consent, but can use an exact saved consent preference', async () => {
    const q = question({
      label: 'I consent to receiving messages',
      kind: 'CHECKBOX',
      options: ['I agree'],
      required: false,
    });
    expect((await prepareGoogleQuestions(input([q])))[0]?.review).toContain(
      'consent',
    );
    const verified: VerifiedAnswer[] = [
      {
        id: 'consent',
        category: 'CUSTOM_QUESTION',
        questionKey: 'i consent to receiving messages',
        value: '["I agree"]',
        source: 'USER_VERIFIED',
        verifiedAt: new Date().toISOString(),
      },
    ];
    expect(
      (await prepareGoogleQuestions({ ...input([q]), verified }))[0],
    ).toMatchObject({ value: ['I agree'], review: null });
  });
  it('selects a role-matched resume ahead of the default and pauses ties', async () => {
    const q = question({
      label: 'Upload resume',
      kind: 'FILE',
      documentType: 'RESUME',
      accept: ['.pdf'],
    });
    const documents = [
      document('default', { isDefault: true }),
      document('matched', { jobTitles: ['Software Engineer'] }),
    ];
    expect(
      (await prepareGoogleQuestions({ ...input([q]), documents }))[0]
        ?.documentId,
    ).toBe('matched');
    documents.push(
      document('also-matched', { jobTitles: ['Software Engineer'] }),
    );
    expect(
      (await prepareGoogleQuestions({ ...input([q]), documents }))[0]?.review,
    ).toContain('More than one');
    expect(
      (
        await prepareGoogleQuestions({
          ...input([q]),
          documents,
          decisions: { [q.id]: 'matched' },
        })
      )[0]?.review,
    ).toBeNull();
  });
  it('does not call AI without evidence and rejects fabricated evidence identifiers', async () => {
    let calls = 0;
    const provider = {
      name: 'controlled',
      generateAnswer: async () => {
        calls++;
        return {
          answer: 'I build TypeScript APIs.',
          category: 'ROLE_MOTIVATION',
          evidenceIds: ['invented'],
          requiresHumanReview: false,
          reasoningSummary: 'Example',
        };
      },
    };
    const q = question({
      label: 'Why are you interested in this TypeScript role?',
      kind: 'PARAGRAPH',
    });
    expect(
      (
        await prepareGoogleQuestions({
          ...input([q]),
          profile: ApplicationProfileSchema.parse({}),
          provider,
        })
      )[0]?.review,
    ).not.toBeNull();
    expect(calls).toBe(0);
    expect(
      (await prepareGoogleQuestions({ ...input([q]), provider }))[0]?.review,
    ).not.toBeNull();
    expect(calls).toBe(1);
  });
  it('supports evidence-grounded AI answers for custom free-text questions', async () => {
    const provider = {
      name: 'controlled',
      generateAnswer: async (context: {
        category: string;
        evidence: { id: string }[];
      }) => ({
        answer: 'TypeScript',
        category: context.category,
        evidenceIds: context.evidence.map((e) => e.id),
        requiresHumanReview: false,
        reasoningSummary: 'Grounded in supplied skills.',
      }),
    };
    const q = question({
      label: 'Describe how you use TypeScript',
      kind: 'PARAGRAPH',
    });
    expect(
      (await prepareGoogleQuestions({ ...input([q]), provider }))[0],
    ).toMatchObject({ source: 'AI', value: 'TypeScript', review: null });
  });
  it('validates exact selections, dates, emails and explicit optional skips', () => {
    expect(
      validGoogleAnswer(question({ kind: 'CHECKBOX', options: ['A', 'B'] }), [
        'A',
        'B',
      ]),
    ).toBe(true);
    expect(
      validGoogleAnswer(question({ kind: 'CHECKBOX', options: ['A'] }), [
        'A',
        'A',
      ]),
    ).toBe(false);
    expect(validGoogleAnswer(question({ kind: 'DATE' }), '2026-02-30')).toBe(
      false,
    );
    expect(validGoogleAnswer(question({ label: 'Email' }), 'invalid')).toBe(
      false,
    );
    expect(validGoogleAnswer(question({ required: false }), null)).toBe(true);
  });
});
