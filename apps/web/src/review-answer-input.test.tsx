import React from 'react';
import { renderToString } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { ReviewAnswerInput } from './components/candidate/ReviewAnswerInput';
import type { ReviewItem } from './lib/candidate-types';

const item: ReviewItem = {
  requirementId: 'native',
  type: 'MISSING_VERIFIED_ANSWER',
  category: 'CUSTOM_QUESTION',
  question: 'What is your native language?',
  reason: 'Choose an answer',
  proposedAnswer: null,
  source: null,
  options: ['English', 'Hindi', 'French'],
  minLength: 1,
  maxLength: 10000,
  fieldType: 'CHECKBOX',
  required: true,
  multiple: true,
  documentType: null,
  acceptedFileTypes: [],
  status: 'PENDING',
  priority: 'NORMAL',
  actions: ['ANSWER'],
};
describe('ATS review field controls', () => {
  it('renders one multi-select question with selected checkboxes and no individual required flags', () => {
    const html = renderToString(
      <ReviewAnswerInput
        item={item}
        id="native"
        value={'["English","Hindi"]'}
        onChange={() => {}}
      />,
    );
    expect(html.match(/type="checkbox"/g)).toHaveLength(3);
    expect(html.match(/checked=""/g)).toHaveLength(2);
    expect(html).not.toContain('<textarea');
    expect(html).not.toContain('required=""');
    expect(html).toContain('<legend');
  });
  it('renders a single-choice radio group', () => {
    const html = renderToString(
      <ReviewAnswerInput
        item={{ ...item, fieldType: 'RADIO', multiple: false }}
        id="source"
        value="English"
        onChange={() => {}}
      />,
    );
    expect(html.match(/type="radio"/g)).toHaveLength(3);
    expect(html.match(/checked=""/g)).toHaveLength(1);
    expect(html.match(/name="source"/g)).toHaveLength(3);
  });
  it.each([
    ['TEXT', 'text'],
    ['EMAIL', 'email'],
    ['PHONE', 'tel'],
    ['URL', 'url'],
    ['NUMBER', 'number'],
    ['DATE', 'date'],
  ])('uses the %s input type', (fieldType, type) => {
    const html = renderToString(
      <ReviewAnswerInput
        item={{
          ...item,
          fieldType,
          multiple: false,
          options: [],
          required: false,
        }}
        id="input"
        value=""
        onChange={() => {}}
      />,
    );
    expect(html).toContain(`type="${type}"`);
    expect(html).not.toContain('required=""');
  });
});
