import { type ApplicationRequirement, type Job } from '@careerlift/domain';

const patterns: Array<[ApplicationRequirement['type'], RegExp, string]> = [
  ['RESUME', /\b(resume|cv|curriculum vitae)\b/i, 'Resume'],
  ['COVER_LETTER', /\bcover letter\b/i, 'Cover letter'],
  ['EMAIL', /\bemail (address|id)\b/i, 'Email address'],
  ['PHONE', /\b(phone|mobile) (number)?\b/i, 'Phone number'],
  ['LINKEDIN', /\blinkedin\b/i, 'LinkedIn profile'],
  ['GITHUB', /\bgithub\b/i, 'GitHub profile'],
  ['PORTFOLIO', /\bportfolio\b/i, 'Portfolio'],
  ['EDUCATION', /\b(education|degree|university)\b/i, 'Education'],
  [
    'WORK_EXPERIENCE',
    /\b(work experience|years of experience)\b/i,
    'Work experience',
  ],
  [
    'SALARY_EXPECTATION',
    /\b(expected salary|salary expectation|desired compensation)\b/i,
    'Salary expectation',
  ],
  [
    'WORK_AUTHORIZATION',
    /\b(work authorization|authorized to work)\b/i,
    'Work authorization',
  ],
  [
    'SPONSORSHIP',
    /\b(visa sponsorship|require sponsorship)\b/i,
    'Visa sponsorship',
  ],
  ['LOCATION', /\b(current location|preferred location)\b/i, 'Location'],
  ['NOTICE_PERIOD', /\bnotice period\b/i, 'Notice period'],
];

export function extractRequirements(job: Job): ApplicationRequirement[] {
  const found = new Map<
    ApplicationRequirement['type'],
    ApplicationRequirement
  >();
  for (const item of job.application?.structuredRequirements ?? [])
    found.set(item.type, item);
  for (const line of job.requirements) {
    for (const [type, pattern, label] of patterns)
      if (pattern.test(line) && !found.has(type)) {
        const status = /\b(optional|preferred|nice to have)\b/i.test(line)
          ? 'optional'
          : /\b(required|must|submit|attach|provide)\b/i.test(line)
            ? 'required'
            : 'unknown';
        found.set(type, { type, status, label, source: 'description' });
      }
  }
  return [...found.values()];
}
