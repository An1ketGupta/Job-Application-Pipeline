import { describe, expect, it } from 'vitest';
import {
  EmailDraftInputSchema,
  rankResumes,
  renderEmailTemplate,
} from './email.js';
describe('Email preparation', () => {
  const resumes = [
    {
      id: 'frontend',
      name: 'Frontend.pdf',
      type: 'RESUME',
      isDefault: false,
      jobTitles: ['Front-end Developer'],
    },
    {
      id: 'backend',
      name: 'Backend.pdf',
      type: 'RESUME',
      isDefault: true,
      jobTitles: ['Backend Engineer'],
    },
    {
      id: 'ai',
      name: 'AI.pdf',
      type: 'RESUME',
      isDefault: false,
      jobTitles: ['AI Engineer', 'Machine Learning Intern'],
    },
    {
      id: 'cover',
      name: 'Cover.pdf',
      type: 'COVER_LETTER',
      isDefault: true,
      jobTitles: ['Frontend Engineer'],
    },
  ];
  it('selects the role-specific resume ahead of a generic default and recognizes title aliases', () => {
    expect(
      rankResumes('Junior Frontend Engineer (Remote)', resumes)[0]?.id,
    ).toBe('frontend');
    expect(rankResumes('AI Intern', resumes)[0]?.id).toBe('ai');
    expect(rankResumes('Machine Learning Engineer', resumes)[0]?.id).toBe('ai');
    expect(rankResumes('Backend Developer', resumes)[0]?.id).toBe('backend');
    expect(rankResumes('React Developer', resumes)[0]?.id).toBe('frontend');
    expect(rankResumes('Accountant', resumes).every((r) => r.score === 0)).toBe(
      true,
    );
    expect(rankResumes('Accountant', resumes)[0]?.id).toBe('backend');
    expect(
      rankResumes('Frontend Engineer', resumes).some((r) => r.id === 'cover'),
    ).toBe(false);
  });
  it('does not recursively interpret placeholder text supplied by a job or profile', () => {
    expect(
      renderEmailTemplate('{{company}} {{fullName}}', {
        company: '{{fullName}}',
        fullName: 'Aniket',
      }),
    ).toBe('{{fullName}} Aniket');
  });
  it('rejects injected headers, duplicate attachments, and unexpected recipient overrides', () => {
    const draft = {
      revision: 0,
      subject: 'Application',
      body: 'Hello',
      documentIds: [],
    };
    expect(
      EmailDraftInputSchema.safeParse({
        ...draft,
        subject: 'Application\r\nBcc: attacker@example.com',
      }).success,
    ).toBe(false);
    expect(
      EmailDraftInputSchema.safeParse({ ...draft, documentIds: ['a', 'a'] })
        .success,
    ).toBe(false);
    expect(
      EmailDraftInputSchema.safeParse({ ...draft, to: 'attacker@example.com' })
        .success,
    ).toBe(false);
  });
});
