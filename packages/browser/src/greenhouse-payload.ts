import { isDeepStrictEqual } from 'node:util';
import { preparedValues, type ExecutionInput } from '@careerlift/domain';
import { InspectionError } from './policy.js';

export type GreenhouseUpload = {
  name: string;
  mimeType: string;
  buffer: Uint8Array;
  url?: string;
};
export function greenhouseApprovedValues(input: ExecutionInput) {
  const values = preparedValues(input),
    approved = new Map<string, string>();
  for (const f of input.inspection.greenhouseSubmission!.fields) {
    if (f.type === 'FILE') continue;
    const value = values.get(f.fieldId);
    if (!value?.trim()) {
      if (f.required)
        throw new InspectionError(
          'REQUIRED_FIELD_MISSING',
          'An answer is missing',
        );
      continue;
    }
    if (f.type === 'SELECT') {
      const options = f.options.filter((o) => o.label === value);
      if (options.length !== 1)
        throw new InspectionError(
          'INVALID_OPTION',
          'An inspected choice is required',
        );
      approved.set(f.name, options[0]!.value);
    } else approved.set(f.name, value);
  }
  const phone = approved.get('phone');
  if (phone && !/^\+[1-9]\d{6,14}$/.test(phone.replace(/[\s().-]/g, '')))
    throw new InspectionError(
      'GREENHOUSE_INTERNATIONAL_PHONE_REQUIRED',
      'Include the country calling code in your phone number',
    );
  return approved;
}

export function greenhouseApplication(
  input: ExecutionInput,
  approved: Map<string, string>,
  files: Map<string, GreenhouseUpload>,
  timeZone: string,
) {
  const app: Record<string, unknown> = {
    first_name: '',
    last_name: '',
    email: '',
    answers_attributes: {},
    demographic_answers: [],
    data_compliance: {},
    attachments: {},
    from_job_board_renderer: true,
    employments: [],
    mapped_url_token: null,
    appcast_click_id: null,
    time_zone: timeZone,
  };
  const answers: Record<string, unknown> = {},
    attachments: Record<string, string> = {};
  let priority = 0;
  for (const f of input.inspection.greenhouseSubmission!.fields) {
    const id = /^question_(\d+)$/.exec(f.name)?.[1];
    if (f.type === 'FILE') {
      const file = files.get(f.name);
      if (!file?.url) {
        if (f.required)
          throw new InspectionError(
            'REQUIRED_DOCUMENT_MISSING',
            'The document upload was not confirmed',
          );
        continue;
      }
      if (id) {
        attachments[`${id}_url`] = file.url;
        attachments[`${id}_url_filename`] = file.name;
      } else {
        app[`${f.name}_url`] = file.url;
        app[`${f.name}_url_filename`] = file.name;
      }
      continue;
    }
    const value = approved.get(f.name);
    if (id) {
      const answer: Record<string, unknown> = {
        question_id: id,
        priority: priority++,
      };
      if (f.type === 'SELECT') {
        if (value === '1' || value === '0')
          answer.boolean_value = Number(value);
        else
          answer.answer_selected_options_attributes = value
            ? { '0': { question_option_id: value } }
            : {};
      } else if (value !== undefined) answer.text_value = value;
      answers[id] = answer;
    } else if (value !== undefined)
      app[f.name] = f.name === 'phone' ? value.replace(/[\s().-]/g, '') : value;
  }
  app.answers_attributes = answers;
  app.attachments = attachments;
  return app;
}

// Validate the complete native payload. No page-supplied applicant data is trusted.
export function validateGreenhousePayload(
  body: Buffer,
  contentType: string,
  expectedApplication: Record<string, unknown>,
  fingerprint: string | undefined,
) {
  if (body.length > 65536 || !/^application\/json(?:\s*;|$)/i.test(contentType))
    throw new InspectionError(
      'GREENHOUSE_UNAPPROVED_VALUE',
      'Unsupported submission payload',
    );
  try {
    const json = JSON.parse(body.toString('utf8'));
    const allowed = [
      'job_application',
      'fingerprint',
      'g-recaptcha-enterprise-token',
      'security_code',
      'captcha_retried',
      'request_token',
    ];
    if (
      !json ||
      typeof json !== 'object' ||
      Array.isArray(json) ||
      Object.keys(json).some((k) => !allowed.includes(k)) ||
      !isDeepStrictEqual(json.job_application, expectedApplication) ||
      json.fingerprint !== fingerprint ||
      (json.captcha_retried !== undefined && json.captcha_retried !== true) ||
      ['security_code', 'request_token', 'g-recaptcha-enterprise-token'].some(
        (k) =>
          json[k] !== undefined &&
          (typeof json[k] !== 'string' || !json[k] || json[k].length > 20000),
      )
    )
      throw new Error();
    return json as Record<string, unknown>;
  } catch {
    throw new InspectionError(
      'GREENHOUSE_UNAPPROVED_VALUE',
      'The employer request differs from your prepared application',
    );
  }
}
