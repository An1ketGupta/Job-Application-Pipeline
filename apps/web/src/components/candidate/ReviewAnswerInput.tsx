'use client';
import React from 'react';
import { selectedChoiceLabels } from '@careerlift/domain';
import type { ReviewItem } from '@/lib/candidate-types';
import { answerReviewInput } from '../applications/AnswerReviewCard';

export function ReviewAnswerInput({
  item,
  id,
  value,
  onChange,
}: {
  item: ReviewItem;
  id: string;
  value: string;
  onChange: (value: string) => void;
}) {
  const required = item.required ?? true;
  if (
    item.fieldType === 'RADIO' ||
    (item.fieldType === 'CHECKBOX' && item.multiple)
  ) {
    const selected = item.multiple
      ? (selectedChoiceLabels(value) ?? [])
      : [value];
    return (
      <fieldset aria-labelledby={`${id}-label`}>
        <legend id={`${id}-label`} className="sr-only">
          {item.question}
        </legend>
        <div className="space-y-2">
          {item.options.map((option, index) => (
            <label key={option} className="flex items-start gap-2 text-sm">
              <input
                id={index === 0 ? id : `${id}-${index}`}
                className="mt-0.5"
                type={item.multiple ? 'checkbox' : 'radio'}
                name={id}
                value={option}
                checked={selected.includes(option)}
                required={!item.multiple && required}
                onChange={(event) =>
                  onChange(
                    item.multiple
                      ? JSON.stringify(
                          item.options.filter((o) =>
                            o === option
                              ? event.target.checked
                              : selected.includes(o),
                          ),
                        )
                      : option,
                  )
                }
              />
              <span>{option}</span>
            </label>
          ))}
        </div>
      </fieldset>
    );
  }
  if (item.fieldType === 'CHECKBOX')
    return (
      <label className="flex items-start gap-2 text-sm">
        <input
          id={id}
          type="checkbox"
          required={required}
          checked={value === 'true'}
          onChange={(e) => onChange(String(e.target.checked))}
        />
        <span>{item.question}</span>
      </label>
    );
  if (item.options.length)
    return (
      <select
        id={id}
        className={answerReviewInput}
        required={required}
        value={value}
        onChange={(e) => onChange(e.target.value)}
      >
        <option value="">Select an answer</option>
        {item.options.map((option) => (
          <option key={option} value={option}>
            {option}
          </option>
        ))}
      </select>
    );
  if (item.fieldType === 'TEXTAREA' || item.fieldType === 'UNKNOWN')
    return (
      <textarea
        id={id}
        className={answerReviewInput}
        required={required}
        minLength={item.minLength}
        maxLength={item.maxLength}
        rows={4}
        value={value}
        onChange={(e) => onChange(e.target.value)}
      />
    );
  const type =
    (
      {
        EMAIL: 'email',
        PHONE: 'tel',
        URL: 'url',
        NUMBER: 'number',
        DATE: 'date',
      } as Record<string, string>
    )[item.fieldType] ?? 'text';
  return (
    <input
      id={id}
      className={answerReviewInput}
      type={type}
      required={required}
      minLength={item.minLength}
      maxLength={item.maxLength}
      value={value}
      onChange={(e) => onChange(e.target.value)}
    />
  );
}
