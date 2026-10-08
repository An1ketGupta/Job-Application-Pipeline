import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { chromium, type Browser } from 'playwright';
import {
  applicationAnswerFields,
  expandApplicationAnswerValues,
  validFieldValue,
  ApplicationSchemaSchema,
  ApplicationProfileSchema,
  PreparationEngine,
  type AnswerBatchInput,
} from '@careerlift/domain';
import { extractPage, classifyPage } from './extract.js';

const languages = [
  'English',
  'Japanese',
  'Chinese',
  'German',
  'Hindi',
  'French',
  'Korean',
  'Portuguese',
  'Italian',
  'Spanish',
  'Indonesian',
  'Dutch',
  'Turkish',
  'Filipino',
  'Polish',
  'Swedish',
  'Bulgarian',
  'Romanian',
  'Arabic',
  'Czech',
  'Greek',
  'Finnish',
  'Croatian',
  'Malay',
  'Slovak',
  'Danish',
  'Tamil',
  'Ukranian',
  'Russian',
  'Other',
];
const group = (
  id: string,
  title: string,
  options: string[],
  type: string,
  required = true,
) =>
  `<fieldset class="ashby-application-form-input-${type}-group">
  <label class="ashby-application-form-question-title ${required ? '_required_fixture' : ''}" for="${id}">${title}</label>
  <div class="ashby-application-form-question-description">Select your answer.</div>
  ${options.map((label, i) => `<div><span><input id="${id}-${i}" type="${type}" name="${type === 'radio' ? id : label}"></span><label for="${id}-${i}">${label}</label></div>`).join('')}</fieldset>`;
const html = `<title>Audiobook Specialists</title><form>
  <fieldset><legend>About you</legend><label for="name">Name</label><input id="name" required></fieldset>
  <div class="ashby-application-form-field-entry"><label class="ashby-application-form-question-title _required_fixture">Location</label><input role="combobox" placeholder="Start typing..."></div>
  ${group('source', 'How did you hear about ElevenLabs?', ["I'm a user", 'News article', 'Job board', 'Social media', 'In person event', 'Referral', 'I was reached out to', 'Other (please specify)'], 'radio')}
  <label for="other">If other, please specify below</label><input id="other">
  ${group('native', 'What is your native language?', languages, 'checkbox')}
  ${group('content', 'Which types of content have you produced dubs for?', ['Movies', 'Creator content', 'Ads', 'E-learning', 'Documentaries'], 'checkbox')}
  ${group('experience', 'Do you also have experience with any of the following?', ['Transcripts', 'Subtitles', 'Translations', 'Audiobooks', 'Audio engineering'], 'checkbox', false)}
  <label for="consent">I agree</label><input id="consent" type="checkbox" required>
  <input hidden id="tracking" required><button type="submit">Submit Application</button>
  </form><script>window.events=0;['input','change','click','submit'].forEach(type=>document.addEventListener(type,()=>window.events++));</script>`;

let browser: Browser;
beforeAll(async () => {
  browser = await chromium.launch({ headless: true });
});
afterAll(async () => {
  await browser?.close();
});

describe('ATS choice question inspection and preparation', () => {
  it('reads Ashby headings, requirement markers and four groups without changing controls', async () => {
    const page = await browser.newPage();
    try {
      await page.setContent(html);
      const raw = await extractPage(page),
        schema = classifyPage(raw);
      const logical = applicationAnswerFields(schema.fields);
      expect(
        logical
          .filter((f) => f.choiceGroup)
          .map((f) => [f.label, f.type, f.required, f.options.length]),
      ).toEqual([
        ['How did you hear about ElevenLabs?', 'RADIO', true, 8],
        ['What is your native language?', 'CHECKBOX', true, 30],
        [
          'Which types of content have you produced dubs for?',
          'CHECKBOX',
          true,
          5,
        ],
        [
          'Do you also have experience with any of the following?',
          'CHECKBOX',
          false,
          5,
        ],
      ]);
      expect(logical.find((f) => f.domId === 'name')?.label).toBe('Name');
      expect(logical.find((f) => f.type === 'SELECT')).toMatchObject({
        label: 'Location',
        required: true,
      });
      expect(logical.find((f) => f.domId === 'other')?.required).toBe(false);
      expect(schema.questions).toHaveLength(4);
      expect(schema.questions.some((q) => languages.includes(q.text))).toBe(
        false,
      );
      expect(
        raw.fields.filter((f) => f.choiceGroup).every((f) => !f.required),
      ).toBe(true);
      expect(
        await page.evaluate(() => ({
          events: (window as unknown as { events: number }).events,
          checked: document.querySelectorAll(':checked').length,
        })),
      ).toEqual({ events: 0, checked: 0 });

      const native = logical.find(
        (f) => f.choiceGroup?.label === 'What is your native language?',
      )!;
      const source = logical.find((f) => f.type === 'RADIO')!;
      expect(validFieldValue('["English","Hindi"]', native)).toBe(true);
      for (const value of [
        'English',
        '[]',
        '["Invented"]',
        '["English","English"]',
      ])
        expect(validFieldValue(value, native)).toBe(false);
      expect(validFieldValue('Referral', source)).toBe(true);
      expect(validFieldValue('Made up', source)).toBe(false);
      const values = expandApplicationAnswerValues(
        schema.fields,
        new Map([
          [native.id, '["English","Hindi"]'],
          [source.id, 'Referral'],
        ]),
      );
      const radio = schema.fields.filter((f) => f.type === 'RADIO');
      expect(
        radio.filter((f) => values.get(f.id) != null).map((f) => f.label),
      ).toEqual(['Referral']);
      // Ashby omits HTML values, so every radio has value "on". Identity selects
      // the chosen control, rather than searching for a unique option value.
      expect(values.get(radio.find((f) => f.label === 'Referral')!.id)).toBe(
        'on',
      );
      expect(
        schema.fields
          .filter(
            (f) =>
              f.choiceGroup?.id === native.choiceGroup!.id &&
              values.get(f.id) === 'true',
          )
          .map((f) => f.label),
      ).toEqual(['English', 'Hindi']);

      const inspection = ApplicationSchemaSchema.parse({
        inspectionId: 'inspection',
        applicationPlanId: 'plan',
        sourceUrl: 'https://example.com/apply',
        finalUrl: 'https://example.com/apply',
        redirectChain: [],
        finalHostname: 'example.com',
        plannedApplicationType: 'EXTERNAL_ATS',
        platform: 'ASHBY',
        platformDiscrepancy: false,
        title: raw.title,
        ...schema,
        forms: raw.forms,
        confidence: 1,
        inspectionMetadata: {
          inspectedAt: new Date().toISOString(),
          durationMs: 1,
          visibleTextExcerpt: '',
          fieldCount: schema.fields.length,
        },
      });
      const generateAnswers = vi.fn(async (input: AnswerBatchInput) => ({
        answers: input.questions.flatMap(() => []),
      }));
      const preparation = await new PreparationEngine({
        name: 'test',
        generateAnswers,
        generateAnswer: async () => ({}),
      }).prepare({
        applicationId: 'app',
        inspectionId: 'inspection',
        job: {
          id: 'job',
          externalId: 'job',
          source: 'test',
          title: 'Audiobook Specialists',
          company: 'ElevenLabs',
          description: '',
          requirements: [],
        },
        schema: inspection,
        email: 'candidate@example.com',
        profile: ApplicationProfileSchema.parse({ fullName: 'Candidate' }),
        documents: [],
        verifiedAnswers: [],
      });
      expect(preparation.questions).toHaveLength(4);
      expect(
        preparation.humanReviewItems.filter((i) =>
          inspection.questions.some((q) => q.id === i.requirementId),
        ),
      ).toHaveLength(3);
      expect(
        preparation.fields.some(
          (f) => schema.fields.find((s) => s.id === f.fieldId)?.choiceGroup,
        ),
      ).toBe(false);
      expect(
        generateAnswers.mock.calls[0]?.[0]?.questions.filter(
          (q: { fieldType: string }) =>
            ['RADIO', 'CHECKBOX'].includes(q.fieldType),
        ),
      ).toHaveLength(4);
    } finally {
      await page.close();
    }
  });

  it('groups accessible controls within their own forms and leaves standalone consent separate', async () => {
    const page = await browser.newPage();
    try {
      await page.setContent(`<form><div role="radiogroup" aria-labelledby="source-title" aria-required="true"><h3 id="source-title">Source</h3><div role="radio" aria-label="Referral"></div><div role="radio" aria-label="Job board"></div></div></form>
        <form><fieldset><legend>Source</legend><label><input type="radio" name="source" value="referral">Referral</label><label><input type="radio" name="source" value="board">Job board</label></fieldset><label><input type="checkbox" required>Consent</label></form>`);
      const fields = applicationAnswerFields((await extractPage(page)).fields);
      expect(fields).toHaveLength(3);
      expect(fields.slice(0, 2).map((f) => f.options)).toEqual([
        ['Referral', 'Job board'],
        ['Referral', 'Job board'],
      ]);
      expect(fields[2]).toMatchObject({
        label: 'Consent',
        type: 'CHECKBOX',
        required: true,
      });
      expect(fields[2]?.choiceGroup).toBeUndefined();
      expect(validFieldValue('false', fields[2])).toBe(false);
    } finally {
      await page.close();
    }
  });
});
