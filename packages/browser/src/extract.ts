import type { ApplicationField, ApplicationSchema } from '@careerlift/domain';
import { applicationAnswerFields } from '@careerlift/domain';
import type { Page } from 'playwright';
import { createHash } from 'node:crypto';

type RawField = ApplicationField & { accept?: string };
export interface RawPageRepresentation {
  title: string;
  visibleText: string;
  signature: string;
  accessibilitySnapshot?: string;
  fields: RawField[];
  forms: ApplicationSchema['forms'];
  links: string[];
  buttons: string[];
  executionFlow?: ApplicationSchema['executionFlow'];
}

export async function extractPage(page: Page): Promise<RawPageRepresentation> {
  const raw = await page.evaluate(() => {
    const bounded = (value: string | null | undefined, max = 1000) =>
      (value ?? '').trim().replace(/\s+/g, ' ').slice(0, max);
    const elements = Array.from(
      document.querySelectorAll<HTMLElement>(
        'input,textarea,select,[role="combobox"],[role="textbox"],[role="checkbox"],[role="radio"]',
      ),
    )
      .filter(
        (element) =>
          !(
            element instanceof HTMLInputElement &&
            ['hidden', 'submit', 'button', 'reset', 'image'].includes(
              element.type,
            )
          ),
      )
      .slice(0, 300);
    const forms = Array.from(document.forms).slice(0, 100);
    const formIds = new Map(
      forms.map((form, index) => [form, `form-${index + 1}`]),
    );
    const groupIds = new Map<Element, string>();
    const labelledBy = (element: Element) =>
      bounded(
        (element.getAttribute('aria-labelledby') ?? '')
          .split(/\s+/)
          .map((id) => document.getElementById(id)?.textContent ?? '')
          .join(' '),
      );
    const fields = elements.map((element, index) => {
      const input = element instanceof HTMLInputElement ? element : undefined;
      const kind = input?.type?.toLowerCase() ?? element.tagName.toLowerCase();
      const role = element.getAttribute('role');
      const container = element.closest(
        'fieldset,[role="radiogroup"],[role="group"],.ashby-application-form-field-entry',
      );
      const heading = container?.querySelector(
        ':scope > legend,:scope > .ashby-application-form-question-title',
      );
      const groupLabel = container
        ? labelledBy(container) ||
          bounded(container.getAttribute('aria-label')) ||
          bounded(heading?.textContent)
        : '';
      const questionRequired =
        container?.hasAttribute('required') ||
        container?.getAttribute('aria-required') === 'true' ||
        Boolean(
          heading &&
          (/\*\s*$/.test(heading.textContent ?? '') ||
            (heading.classList.contains(
              'ashby-application-form-question-title',
            ) &&
              /(?:^|\s)_required_/.test(heading.className))),
        );
      const description = bounded(
        container?.querySelector('.ashby-application-form-question-description')
          ?.textContent,
      );
      const type: ApplicationField['type'] =
        kind === 'email'
          ? 'EMAIL'
          : kind === 'tel'
            ? 'PHONE'
            : kind === 'url'
              ? 'URL'
              : kind === 'number'
                ? 'NUMBER'
                : kind === 'date'
                  ? 'DATE'
                  : kind === 'file'
                    ? 'FILE'
                    : kind === 'checkbox' || role === 'checkbox'
                      ? 'CHECKBOX'
                      : kind === 'radio' || role === 'radio'
                        ? 'RADIO'
                        : kind === 'textarea'
                          ? 'TEXTAREA'
                          : kind === 'select' || role === 'combobox'
                            ? 'SELECT'
                            : ['text', 'search', 'password'].includes(kind) ||
                                role === 'textbox'
                              ? 'TEXT'
                              : 'UNKNOWN';
      const domId = bounded(element.id, 200);
      const label = bounded(
        (element as HTMLInputElement).labels?.[0]?.textContent ||
          (domId
            ? document.querySelector(`label[for="${CSS.escape(domId)}"]`)
                ?.textContent
            : '') ||
          element.closest('label')?.textContent ||
          element.getAttribute('aria-label') ||
          labelledBy(element) ||
          element.getAttribute('placeholder') ||
          element.getAttribute('name') ||
          '',
        1000,
      );
      const isChoice = type === 'RADIO' || type === 'CHECKBOX';
      const groupControls = container
        ? Array.from(
            container.querySelectorAll<HTMLElement>(
              'input[type="radio"],input[type="checkbox"],[role="radio"],[role="checkbox"]',
            ),
          ).filter(
            (control) =>
              control.closest(
                'fieldset,[role="radiogroup"],[role="group"],.ashby-application-form-field-entry',
              ) === container,
          )
        : [];
      const group =
        isChoice && container && groupLabel && groupControls.length > 0
          ? container
          : undefined;
      if (group && !groupIds.has(group))
        groupIds.set(group, `choice-group-${groupIds.size + 1}`);
      const form = (element as HTMLInputElement).form;
      const style = getComputedStyle(element);
      const rect = element.getBoundingClientRect();
      const visible =
        style.display !== 'none' &&
        style.visibility !== 'hidden' &&
        rect.width > 0 &&
        rect.height > 0 &&
        !element.closest('[hidden],[aria-hidden="true"]');
      const options =
        element instanceof HTMLSelectElement
          ? Array.from(element.options)
              .slice(0, 100)
              .map((option) => bounded(option.textContent, 1000))
          : [];
      return {
        id: `field-${index + 1}`,
        ...(domId ? { domId } : {}),
        ...(element.getAttribute('name')
          ? { name: bounded(element.getAttribute('name'), 1000) }
          : {}),
        label,
        ...(groupLabel &&
        (isChoice ||
          container?.classList.contains('ashby-application-form-field-entry'))
          ? {
              questionLabel: groupLabel.replace(/\s*\*\s*$/, ''),
              questionRequired: Boolean(
                questionRequired ||
                element.hasAttribute('required') ||
                element.getAttribute('aria-required') === 'true',
              ),
            }
          : {}),
        ...(description ? { description } : {}),
        ...(group
          ? {
              choiceGroup: {
                id: groupIds.get(group)!,
                label: groupLabel.replace(/\s*\*\s*$/, ''),
                required: Boolean(
                  questionRequired ||
                  groupControls.some(
                    (c) =>
                      c.hasAttribute('required') ||
                      c.getAttribute('aria-required') === 'true',
                  ),
                ),
              },
            }
          : {}),
        type,
        required:
          element.hasAttribute('required') ||
          element.getAttribute('aria-required') === 'true',
        visible: Boolean(visible),
        disabled:
          (element as HTMLInputElement).disabled === true ||
          element.getAttribute('aria-disabled') === 'true',
        readonly:
          (element as HTMLInputElement).readOnly === true ||
          element.getAttribute('aria-readonly') === 'true',
        ...(element.getAttribute('placeholder')
          ? { placeholder: bounded(element.getAttribute('placeholder')) }
          : {}),
        ...(element.getAttribute('aria-label')
          ? { ariaLabel: bounded(element.getAttribute('aria-label')) }
          : {}),
        ...(element.getAttribute('aria-describedby')
          ? {
              ariaDescribedBy: bounded(
                element.getAttribute('aria-describedby'),
              ),
            }
          : {}),
        options,
        htmlType:
          (element as HTMLInputElement).type ?? element.tagName.toLowerCase(),
        ...(element instanceof HTMLSelectElement
          ? {
              selectOptions: Array.from(element.options)
                .slice(0, 100)
                .map((o) => ({
                  label: o.textContent?.trim() ?? '',
                  value: o.value,
                  disabled:
                    o.disabled ||
                    (o.parentElement instanceof HTMLOptGroupElement &&
                      o.parentElement.disabled),
                })),
            }
          : {}),
        ...(type === 'CHECKBOX' && input ? { checkboxValue: input.value } : {}),
        ...(type === 'RADIO' && input ? { optionValue: input.value } : {}),
        ...(input && input.minLength >= 0
          ? { minLength: input.minLength }
          : {}),
        ...(input && input.maxLength > 0 ? { maxLength: input.maxLength } : {}),
        ...(form && formIds.get(form) ? { formId: formIds.get(form)! } : {}),
        ...(domId ? { selector: `#${CSS.escape(domId)}` } : {}),
        source: 'DOM' as const,
        ...(type === 'FILE' && input?.accept
          ? { accept: bounded(input.accept) }
          : {}),
      };
    });
    const formData = forms.map((form, index) => {
      const id = `form-${index + 1}`;
      const action = form.getAttribute('action');
      let actionUrl: string | undefined;
      try {
        if (action) actionUrl = new URL(action, location.href).href;
      } catch {
        /* malformed action */
      }
      const method = form.method.toUpperCase();
      return {
        id,
        ...(actionUrl ? { actionUrl } : {}),
        method: (method === 'GET' || method === 'POST' ? method : 'OTHER') as
          'GET' | 'POST' | 'OTHER',
        ...(form.getAttribute('aria-label') ||
        form.querySelector('legend')?.textContent
          ? {
              label: bounded(
                form.getAttribute('aria-label') ||
                  form.querySelector('legend')?.textContent,
              ),
            }
          : {}),
        fieldIds: fields
          .filter((field) => field.formId === id)
          .map((field) => field.id),
        submitControls: Array.from(
          form.querySelectorAll('button,input[type="submit"]'),
        )
          .slice(0, 30)
          .map((button) =>
            bounded(
              button.textContent ||
                button.getAttribute('value') ||
                button.getAttribute('aria-label'),
            ),
          ),
        hiddenFields: Array.from(form.elements)
          .filter(
            (e): e is HTMLInputElement =>
              e instanceof HTMLInputElement && e.type === 'hidden',
          )
          .slice(0, 100)
          .map((e) => ({ name: e.name, value: e.value })),
      };
    });
    const metadata = Array.from(
      document.querySelectorAll('meta[name],meta[property]'),
    )
      .slice(0, 50)
      .map(
        (meta) =>
          `${meta.getAttribute('name') || meta.getAttribute('property')}:${bounded(meta.getAttribute('content'), 200)}`,
      )
      .join(' ');
    const form = forms.length === 1 ? forms[0] : undefined;
    const submits = form
      ? Array.from(
          form.querySelectorAll<HTMLInputElement | HTMLButtonElement>(
            'button,input[type="submit"]',
          ),
        ).filter((c) => c.type === 'submit')
      : [];
    const submit = submits.length === 1 ? submits[0] : undefined;
    let actionUrl: string | undefined;
    try {
      if (form)
        actionUrl = new URL(
          form.getAttribute('action') || location.href,
          location.href,
        ).href;
    } catch {
      /* Invalid actions remain inspectable but cannot produce an execution flow. */
    }
    const submitLabel = submit
      ? bounded(
          submit.textContent ||
            submit.getAttribute('value') ||
            submit.getAttribute('aria-label'),
        )
      : '';
    const executionFlow =
      submit?.id &&
      form &&
      form.method.toUpperCase() === 'POST' &&
      bounded(document.title) &&
      submitLabel &&
      /^(?:submit(?: application)?|apply(?: now)?|send application)$/i.test(
        submitLabel,
      ) &&
      !Array.from(form.querySelectorAll('button,input[type="submit"]')).some(
        (e) =>
          /^(next|continue|save|review|back)$/i.test(
            (e.textContent || e.getAttribute('value') || '').trim(),
          ),
      ) &&
      actionUrl?.startsWith('https:') &&
      /^https:/.test(location.href)
        ? {
            pages: [
              {
                url: location.href,
                title: bounded(document.title),
                fieldIds: fields.map((f) => f.id),
                action: 'SUBMIT' as const,
                control: {
                  domId: submit.id,
                  label: submitLabel,
                  formId: 'form-1',
                  htmlType: 'submit' as const,
                  actionUrl,
                  method: form.method.toUpperCase() as 'GET' | 'POST',
                },
                expectedUrl: actionUrl,
              },
            ],
          }
        : undefined;
    return {
      title: bounded(document.title),
      visibleText: bounded(document.body?.innerText, 4000),
      signature: bounded(
        `${document.documentElement.outerHTML.slice(0, 15000)} ${metadata}`,
        16000,
      ),
      fields,
      forms: formData,
      ...(executionFlow ? { executionFlow } : {}),
      links: Array.from(document.querySelectorAll('a[href]'))
        .slice(0, 100)
        .map((link) => bounded(link.textContent, 200)),
      buttons: Array.from(
        document.querySelectorAll('button,input[type="submit"]'),
      )
        .slice(0, 100)
        .map((button) =>
          bounded(
            button.textContent ||
              button.getAttribute('value') ||
              button.getAttribute('aria-label'),
            200,
          ),
        ),
    };
  });
  const accessibilitySnapshot = await page
    .locator('body')
    .ariaSnapshot({ timeout: 3000 })
    .then((value) => value.slice(0, 4000))
    .catch(() => undefined);
  return {
    ...raw,
    forms: raw.forms.map((form) => ({
      ...form,
      hiddenFields: form.hiddenFields.map((field) => ({
        name: field.name,
        valueDigest: createHash('sha256').update(field.value).digest('hex'),
      })),
    })),
    ...(accessibilitySnapshot ? { accessibilitySnapshot } : {}),
  };
}

export function classifyPage(raw: RawPageRepresentation) {
  const text = `${raw.title} ${raw.visibleText} ${raw.signature}`;
  const captcha =
    /recaptcha|hcaptcha|cf-turnstile|cloudflare challenge|verify you are human|captcha/i.test(
      text,
    );
  const auth =
    /sign in to apply|log in to apply|login required|account required|sso|password/i.test(
      text,
    ) &&
    (raw.fields.some(
      (f) => /password/i.test(f.name ?? '') || /password/i.test(f.label),
    ) ||
      /sign in to apply|log in to apply|login required|account required|sso/i.test(
        text,
      ));
  const interactive = !captcha && !auth && raw.fields.length === 0;
  const questions: ApplicationSchema['questions'] = [];
  const documents: ApplicationSchema['documents'] = [];
  const fields: ApplicationField[] = raw.fields.map((field) => ({
    id: field.id,
    ...(field.domId ? { domId: field.domId } : {}),
    ...(field.name ? { name: field.name } : {}),
    label: field.label,
    ...(field.questionLabel ? { questionLabel: field.questionLabel } : {}),
    ...(field.questionRequired !== undefined
      ? { questionRequired: field.questionRequired }
      : {}),
    ...(field.description ? { description: field.description } : {}),
    ...(field.choiceGroup ? { choiceGroup: field.choiceGroup } : {}),
    type: field.type,
    required: field.required,
    visible: field.visible,
    disabled: field.disabled,
    readonly: field.readonly,
    ...(field.placeholder ? { placeholder: field.placeholder } : {}),
    ...(field.ariaLabel ? { ariaLabel: field.ariaLabel } : {}),
    ...(field.ariaDescribedBy
      ? { ariaDescribedBy: field.ariaDescribedBy }
      : {}),
    options: field.options,
    ...(field.htmlType ? { htmlType: field.htmlType } : {}),
    ...(field.phoneFormat ? { phoneFormat: field.phoneFormat } : {}),
    ...(field.selectOptions ? { selectOptions: field.selectOptions } : {}),
    ...(field.checkboxValue !== undefined
      ? { checkboxValue: field.checkboxValue }
      : {}),
    ...(field.optionValue !== undefined
      ? { optionValue: field.optionValue }
      : {}),
    ...(field.minLength !== undefined ? { minLength: field.minLength } : {}),
    ...(field.maxLength !== undefined ? { maxLength: field.maxLength } : {}),
    ...(field.formId ? { formId: field.formId } : {}),
    ...(field.selector ? { selector: field.selector } : {}),
    source: field.source,
    ...(field.semanticType ? { semanticType: field.semanticType } : {}),
  }));
  for (const rawField of applicationAnswerFields(raw.fields)) {
    const label = `${rawField.label} ${rawField.name ?? ''}`.toLowerCase();
    if (rawField.type === 'FILE') {
      const type = /resume|cv\b/.test(label)
        ? 'RESUME'
        : /cover letter/.test(label)
          ? 'COVER_LETTER'
          : /portfolio/.test(label)
            ? 'PORTFOLIO'
            : /transcript/.test(label)
              ? 'TRANSCRIPT'
              : 'OTHER';
      documents.push({
        type,
        label: rawField.label,
        required: rawField.required,
        fieldId: rawField.id,
        acceptedFileTypes:
          raw.fields
            .find((f) => f.id === rawField.id)
            ?.accept?.split(',')
            .map((s) => s.trim())
            .filter(Boolean)
            .slice(0, 30) ?? [],
        humanReviewRequired: false,
      });
      continue;
    }
    const sensitive =
      /work authori[sz]ation|visa|sponsor|criminal|convict|legal declaration|salary|compensation|security clearance|relocat|gender|ethnic|race|disabilit|veteran/i.test(
        label,
      );
    const demographic = /gender|ethnic|race|disabilit|veteran/i.test(label);
    const normalProfile =
      /^(first name|last name|full name|name|email|phone|mobile|address|city|state|country|linkedin|github|portfolio|website|degree|college|university|graduation date|skills?)$/i.test(
        rawField.label.trim(),
      );
    const question =
      !normalProfile &&
      (sensitive ||
        Boolean(rawField.choiceGroup) ||
        rawField.type === 'TEXTAREA' ||
        /\?|why |describe|tell us|experience|how many|are you|do you/i.test(
          rawField.label,
        ));
    if (question)
      questions.push({
        id: `question-${questions.length + 1}`,
        text: rawField.label,
        fieldId: rawField.id,
        type: rawField.type,
        required: rawField.required,
        sensitivity: demographic
          ? 'DEMOGRAPHIC'
          : sensitive
            ? 'CONSEQUENTIAL'
            : 'NONE',
        semanticType: /sponsor/i.test(label)
          ? 'SPONSORSHIP'
          : /authori[sz]ation/i.test(label)
            ? 'WORK_AUTHORIZATION'
            : /salary|compensation/i.test(label)
              ? 'SALARY_EXPECTATION'
              : 'CUSTOM_QUESTION',
        answerSource: 'UNRESOLVED',
        humanReviewRequired: sensitive,
      });
  }
  const reasons: ApplicationSchema['humanReview']['reasons'] = [];
  if (captcha) reasons.push('CAPTCHA');
  if (auth) reasons.push('AUTHENTICATION_REQUIRED');
  if (interactive) reasons.push('INTERACTIVE_DISCOVERY_REQUIRED');
  if (questions.some((q) => q.humanReviewRequired))
    reasons.push('SENSITIVE_QUESTION');
  return {
    fields,
    questions,
    documents,
    authentication: { required: auth },
    humanReview: { required: reasons.length > 0, reasons },
  };
}
