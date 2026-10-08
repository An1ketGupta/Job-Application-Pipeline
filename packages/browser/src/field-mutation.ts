import type { Page, CDPSession } from 'playwright';
import type { ApplicationField } from '@careerlift/domain';
import { InspectionError } from './policy.js';
import {
  isolatedContext,
  refuseMutationHooks,
  refuseFieldListeners,
  suspendPageScripts,
} from './trusted-dom.js';

const fieldSelector = (expected: ApplicationField) => {
  const quote = (s: string) =>
    `"${s
      .replace(/\\/g, '\\\\')
      .replace(/"/g, '\\"')
      .replace(/[\r\n\f]/g, ' ')}"`;
  return expected.domId
    ? `[id=${quote(expected.domId)}]`
    : expected.name
      ? `[name=${quote(expected.name)}]`
      : undefined;
};

async function resolveFieldNode(
  cdp: CDPSession,
  rootId: number,
  expected: ApplicationField,
) {
  const selector = fieldSelector(expected);
  if (selector) {
    const matches = await cdp.send('DOM.querySelectorAll', {
      nodeId: rootId,
      selector,
    });
    if (matches.nodeIds.length !== 1)
      throw new InspectionError(
        'STALE_DOM_FIELD',
        'Control is missing or ambiguous',
      );
    return matches.nodeIds[0]!;
  }
  if (!expected.label)
    throw new InspectionError('STALE_DOM_FIELD', 'Control identity required');
  const context = await isolatedContext(cdp);
  const find = function (label: string) {
    const matches = Array.from(
      document.querySelectorAll('input,textarea,select'),
    ).filter((element) => {
      const control = element as HTMLInputElement;
      return (
        (
          control.labels?.[0]?.textContent ||
          element.getAttribute('aria-label') ||
          ''
        )
          .trim()
          .replace(/\s+/g, ' ') === label
      );
    });
    return matches.length === 1 ? matches[0] : null;
  };
  const result = await cdp.send('Runtime.callFunctionOn', {
    executionContextId: context,
    functionDeclaration: find.toString(),
    arguments: [{ value: expected.label }],
  });
  if (result.exceptionDetails || !result.result.objectId)
    throw new InspectionError(
      'STALE_DOM_FIELD',
      'Exact associated label is missing or ambiguous',
    );
  const target = await cdp.send('DOM.requestNode', {
    objectId: result.result.objectId,
  });
  return target.nodeId;
}

export async function pinField(page: Page, expected: ApplicationField) {
  const cdp = await page.context().newCDPSession(page);
  try {
    const snapshot = await cdp.send('DOM.getDocument');
    const nodeId = await resolveFieldNode(cdp, snapshot.root.nodeId, expected);
    const node = await cdp.send('DOM.describeNode', { nodeId });
    return node.node.backendNodeId;
  } finally {
    await cdp.detach();
  }
}

export async function mutateBoundField(
  page: Page,
  expected: ApplicationField,
  value: string,
  backendNodeId: number,
) {
  const suspension = await suspendPageScripts(page);
  try {
    const cdp = suspension.cdp;
    const snapshot = await cdp.send('DOM.getDocument', { depth: -1 });
    const nodeId = await resolveFieldNode(cdp, snapshot.root.nodeId, expected);
    const live = await cdp.send('DOM.describeNode', { nodeId });
    if (live.node.backendNodeId !== backendNodeId)
      throw new InspectionError(
        'STALE_DOM_FIELD',
        'Original bound control was replaced',
      );
    const main = await cdp.send('DOM.resolveNode', { nodeId });
    if (!main.object.objectId)
      throw new InspectionError('STALE_DOM_FIELD', 'Bound control unavailable');
    await refuseMutationHooks(cdp, main.object.objectId);
    const parents = new Map<number, number>();
    const pending = [snapshot.root];
    while (pending.length) {
      const node = pending.pop()!;
      for (const child of node.children ?? []) {
        parents.set(child.nodeId, node.nodeId);
        pending.push(child);
      }
    }
    for (
      let parent = parents.get(nodeId);
      parent;
      parent = parents.get(parent)
    ) {
      const ancestor = await cdp.send('DOM.resolveNode', { nodeId: parent });
      if (ancestor.object.objectId)
        await refuseFieldListeners(cdp, ancestor.object.objectId);
    }
    const global = await cdp.send('Runtime.evaluate', { expression: 'this' });
    if (!global.result.objectId)
      throw new InspectionError(
        'UNTRUSTED_FIELD_HOOK',
        'Event inspection incomplete',
      );
    await refuseFieldListeners(cdp, global.result.objectId);
    const context = await isolatedContext(cdp);
    const target = await cdp.send('DOM.resolveNode', {
      nodeId,
      executionContextId: context,
    });
    // The same pinned DOM node is validated and written in a fresh isolated
    // realm. No page setters, synthetic events, or second locator participate.
    const mutate = function (
      this: HTMLElement,
      { expected, value }: { expected: ApplicationField; value: string },
    ) {
      // CDP binds this to the pinned DOM object in the isolated realm.
      // eslint-disable-next-line @typescript-eslint/no-this-alias
      const element = this;
      const control = element as HTMLInputElement;
      const label = (
        control.labels?.[0]?.textContent ||
        element.getAttribute('aria-label') ||
        element.getAttribute('placeholder') ||
        element.getAttribute('name') ||
        ''
      )
        .trim()
        .replace(/\s+/g, ' ');
      const types: Record<string, string> = {
        text: 'TEXT',
        search: 'TEXT',
        email: 'EMAIL',
        tel: 'PHONE',
        url: 'URL',
        number: 'NUMBER',
        date: 'DATE',
        textarea: 'TEXTAREA',
        'select-one': 'SELECT',
        radio: 'RADIO',
        checkbox: 'CHECKBOX',
        file: 'FILE',
      };
      const options =
        element instanceof HTMLSelectElement
          ? Array.from(element.options).map((o) => ({
              label: o.textContent?.trim() ?? '',
              value: o.value,
              disabled:
                o.disabled ||
                (o.parentElement instanceof HTMLOptGroupElement &&
                  o.parentElement.disabled),
            }))
          : undefined;
      const rect = element.getBoundingClientRect(),
        style = getComputedStyle(element);
      if (
        !element.isConnected ||
        !['INPUT', 'TEXTAREA', 'SELECT'].includes(element.tagName) ||
        control.type === 'password' ||
        types[control.type] !== expected.type ||
        (expected.htmlType && control.type !== expected.htmlType) ||
        (expected.domId && element.id !== expected.domId) ||
        (expected.name && control.name !== expected.name) ||
        label !== expected.label ||
        (control.required ||
          element.getAttribute('aria-required') === 'true') !==
          expected.required ||
        (element.getAttribute('placeholder') ?? undefined) !==
          expected.placeholder ||
        (element.getAttribute('aria-label') ?? undefined) !==
          expected.ariaLabel ||
        (element.getAttribute('aria-describedby') ?? undefined) !==
          expected.ariaDescribedBy ||
        (control.form
          ? `form-${Array.from(document.forms).indexOf(control.form) + 1}`
          : undefined) !== expected.formId ||
        control.disabled ||
        control.readOnly ||
        control.matches(':disabled') ||
        element.getAttribute('aria-disabled') === 'true' ||
        element.getAttribute('aria-readonly') === 'true' ||
        style.display === 'none' ||
        style.visibility === 'hidden' ||
        rect.width <= 0 ||
        rect.height <= 0 ||
        element.closest('[hidden],[aria-hidden="true"]') ||
        (expected.type === 'RADIO' && control.value !== expected.optionValue) ||
        (expected.type === 'CHECKBOX' &&
          expected.checkboxValue !== undefined &&
          control.value !== expected.checkboxValue) ||
        (expected.type === 'SELECT' &&
          (!expected.selectOptions ||
            JSON.stringify(options) !== JSON.stringify(expected.selectOptions)))
      )
        return 'STALE_DOM_FIELD';
      if (expected.type === 'SELECT') {
        const matches = options!.filter(
          (o) => !o.disabled && (o.label === value || o.value === value),
        );
        if (matches.length !== 1) return 'INVALID_OPTION';
        Object.getOwnPropertyDescriptor(
          HTMLSelectElement.prototype,
          'value',
        )!.set!.call(element, matches[0]!.value);
      } else if (expected.type === 'CHECKBOX' || expected.type === 'RADIO') {
        Object.getOwnPropertyDescriptor(
          HTMLInputElement.prototype,
          'checked',
        )!.set!.call(element, expected.type === 'RADIO' || value === 'true');
      } else {
        const prototype =
          element instanceof HTMLTextAreaElement
            ? HTMLTextAreaElement.prototype
            : HTMLInputElement.prototype;
        Object.getOwnPropertyDescriptor(prototype, 'value')!.set!.call(
          element,
          value,
        );
      }
      return 'OK';
    };
    const response = await cdp.send('Runtime.callFunctionOn', {
      objectId: target.object.objectId!,
      functionDeclaration: mutate.toString(),
      arguments: [{ value: { expected, value } }],
      returnByValue: true,
    });
    const outcome = response.exceptionDetails
      ? 'STALE_DOM_FIELD'
      : response.result.value;
    if (outcome !== 'OK')
      throw new InspectionError(
        String(outcome),
        'Live control does not match the inspected field',
      );
  } finally {
    await suspension.release();
  }
}
