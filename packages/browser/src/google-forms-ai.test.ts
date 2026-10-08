import { describe, expect, it, vi } from 'vitest';
import { GeminiFormAnswerProvider } from './google-forms-ai.js';
describe('Gemini form answer provider', () => {
  it('requests confidence and verifiable citations for a batch using the full candidate context', async () => {
    const http = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            candidates: [
              {
                finishReason: 'STOP',
                content: { parts: [{ text: '{"answers":[]}' }] },
              },
            ],
          }),
        ),
    );
    const provider = new GeminiFormAnswerProvider(
      'key',
      'gemini-2.5-flash',
      http as typeof fetch,
    );
    await provider.generateAnswers({
      questions: [],
      profile: {
        fullName: 'Ada',
        education: [],
        projects: [],
        experience: [],
        skills: [],
        achievements: [],
        certifications: [],
      },
      resume: {
        documentId: 'resume',
        name: 'selected.txt',
        text: 'Complete resume text',
        status: 'READY',
      },
      email: 'ada@example.com',
      verifiedAnswers: [],
      evidence: [],
      job: { title: 'Engineer', company: 'Example', requirements: [] },
    });
    const [, options] = http.mock.calls[0] as unknown as [string, RequestInit];
    const request = JSON.parse(String(options.body));
    expect(request.contents[0].parts[0].text).toContain('Complete resume text');
    expect(
      request.generationConfig.responseSchema.properties.answers.items.required,
    ).toContain('confidence');
    expect(
      request.generationConfig.responseSchema.properties.answers.items.required,
    ).toContain('conflictingInformation');
  });
  it('sends only supplied evidence/context and validates structured output', async () => {
    const output = {
      answer: 'I build TypeScript APIs.',
      category: 'ROLE_MOTIVATION',
      evidenceIds: ['skill-1'],
      requiresHumanReview: false,
      reasoningSummary: 'Uses supplied evidence.',
    };
    const http = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            candidates: [
              {
                finishReason: 'STOP',
                content: {
                  parts: [
                    { text: 'internal reasoning', thought: true },
                    { text: JSON.stringify(output) },
                  ],
                },
              },
            ],
          }),
          { status: 200 },
        ),
    );
    const provider = new GeminiFormAnswerProvider(
      'private-test-key',
      'gemini-2.5-flash',
      http as typeof fetch,
    );
    expect(
      await provider.generateAnswer({
        question: 'Why this role?',
        category: 'ROLE_MOTIVATION',
        job: { title: 'Engineer', company: 'Example', requirements: [] },
        evidence: [
          { id: 'skill-1', category: 'SKILL', text: 'TypeScript', tags: [] },
        ],
      }),
    ).toEqual(output);
    expect(http.mock.calls).toHaveLength(1);
    const invocation = http.mock.calls[0] as unknown as [string, RequestInit];
    expect(invocation[0]).not.toContain('private-test-key');
    expect(invocation[1].redirect).toBe('error');
    expect(String(invocation[1].body)).toContain('userEvidence');
  });
  it('fails on provider refusal and malformed output instead of returning invented answers', async () => {
    const provider = new GeminiFormAnswerProvider(
      'key',
      'gemini-2.5-flash',
      (async () =>
        new Response(
          JSON.stringify({ candidates: [{ finishReason: 'SAFETY' }] }),
          { status: 200 },
        )) as typeof fetch,
    );
    await expect(
      provider.generateAnswer({
        question: 'Q',
        category: 'CUSTOM_QUESTION',
        job: { title: 'Engineer', company: 'Example', requirements: [] },
        evidence: [],
      }),
    ).rejects.toThrow('INVALID_OUTPUT');
  });
});
