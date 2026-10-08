import { randomUUID } from 'node:crypto';
import type { CDPSession, Page } from 'playwright';
import { InspectionError } from './policy.js';

// Chromium enforces this flag outside the page's JavaScript realm. Protocol
// inspection and our isolated-world calls remain available while scripts stop.
export async function suspendPageScripts(page: Page) {
  const cdp = await page.context().newCDPSession(page);
  try {
    // OOPIF renderers require their own protocol targets. Do not certify a
    // multi-frame dispatch with only the main renderer suspended.
    if (page.frames().length !== 1)
      throw new InspectionError(
        'SECURITY_INSPECTION_INCOMPLETE',
        'Multiple renderers cannot be fenced',
      );
    await cdp.send('Emulation.setScriptExecutionDisabled', { value: true });
  } catch (error) {
    await cdp.detach().catch(() => {});
    throw error;
  }
  return {
    cdp,
    release: async () => {
      try {
        await cdp.send('Emulation.setScriptExecutionDisabled', {
          value: false,
        });
      } finally {
        await cdp.detach().catch(() => {});
      }
    },
  };
}

export async function isolatedContext(cdp: CDPSession) {
  const tree = await cdp.send('Page.getFrameTree');
  const world = await cdp.send('Page.createIsolatedWorld', {
    frameId: tree.frameTree.frame.id,
    worldName: `careerlift-${randomUUID()}`,
  });
  return world.executionContextId;
}

// Protocol properties are inspected without invoking page getters or trusting
// Function#toString. A replaced accessor/proxy is refused before value transfer.
export async function refuseMutationHooks(cdp: CDPSession, objectId: string) {
  let current: string | undefined = objectId;
  const sensitive = new Set([
    'value',
    'checked',
    'type',
    'name',
    'id',
    'form',
    'labels',
    'required',
    'disabled',
    'readOnly',
  ]);
  for (let depth = 0; current && depth < 12; depth++) {
    const inspectedObject: string = current;
    const properties = await cdp.send('Runtime.getProperties', {
      objectId: inspectedObject,
      ownProperties: true,
    });
    for (const property of properties.result) {
      if (!sensitive.has(property.name)) continue;
      if (depth === 0)
        throw new InspectionError(
          'UNTRUSTED_FIELD_HOOK',
          'Own control property overrides are unsupported',
        );
      if (property.value)
        throw new InspectionError(
          'UNTRUSTED_FIELD_HOOK',
          'Control data-property overrides are unsupported',
        );
      for (const accessor of [property.get, property.set]) {
        if (!accessor?.objectId) continue;
        const details = await cdp.send('Runtime.getProperties', {
          objectId: accessor.objectId,
          ownProperties: true,
        });
        if (
          !accessor.description?.includes('[native code]') ||
          details.internalProperties?.some((p) =>
            [
              '[[FunctionLocation]]',
              '[[TargetFunction]]',
              '[[Handler]]',
            ].includes(p.name),
          )
        )
          throw new InspectionError(
            'UNTRUSTED_FIELD_HOOK',
            'Page-controlled control accessors are unsupported',
          );
      }
    }
    current = properties.internalProperties?.find(
      (p) => p.name === '[[Prototype]]',
    )?.value?.objectId;
  }
  if (current)
    throw new InspectionError(
      'UNTRUSTED_FIELD_HOOK',
      'Control prototype inspection incomplete',
    );
  // No input/change events are emitted by trusted writes. Refuse handlers as
  // well: reactive forms requiring these events need a separately approved adapter.
  await refuseFieldListeners(cdp, objectId);
}

export async function refuseFieldListeners(cdp: CDPSession, objectId: string) {
  const listeners = await cdp.send('DOMDebugger.getEventListeners', {
    objectId,
    depth: 0,
    pierce: true,
  });
  if (
    listeners.listeners.some((l) =>
      ['beforeinput', 'input', 'change'].includes(l.type),
    )
  )
    throw new InspectionError(
      'UNTRUSTED_FIELD_HOOK',
      'Page-controlled field event handlers are unsupported',
    );
}
