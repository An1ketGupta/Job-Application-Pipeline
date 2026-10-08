import type { CDPSession, Page } from 'playwright';
import { digest } from './mutation-contract.js';

type SecurityNode = {
  backendNodeId: number;
  nodeName: string;
  nodeValue: string;
  attributes?: string[];
  shadowRootType?: string;
  children?: SecurityNode[];
  shadowRoots?: SecurityNode[];
  contentDocument?: SecurityNode;
};
export type SecurityControlIdentity = {
  backendNodeId: number;
  structuralDigest: string;
  locationDigest: string;
};
export type SecuritySnapshot = {
  documentBackendNodeId?: number;
  surroundingDomDigest?: string;
  complete: boolean;
  captcha: boolean;
  authentication: boolean;
  fingerprint: string;
  controls: SecurityControlIdentity[];
  nodes: SecurityControlIdentity[];
};

// Browser protocol data, never page-owned getters, selectors or bounded HTML.
// Backend identities survive text, attribute, visibility and location changes in
// the retained document. Structural identities additionally catch replacement.
export async function inspectSecurityControls(
  page: Page,
  trustedSession?: CDPSession,
  options?: { allowRecaptchaFrames?: boolean },
): Promise<SecuritySnapshot> {
  let complete = true,
    captcha = false,
    authentication = false;
  const controls = new Map<number, SecurityControlIdentity>();
  const identities: SecurityControlIdentity[] = [];
  const records: { id: number; parent: number | undefined; data: unknown[] }[] =
    [];
  let documentBackendNodeId: number | undefined;
  const challenge =
    /captcha|recaptcha|hcaptcha|turnstile|cf-chl|cf-challenge|challenges\.cloudflare\.com|cloudflare.{0,30}challenge|verify you are human|security challenge|human verification/i;
  const auth =
    /sign in to apply|log in to apply|login required|account required|authentication required|verification.{0,30}(?:code|required|email|identity|phone)|(?:email|identity|security|account).{0,30}verification|verify (?:your )?(?:email|identity|account|phone)|two.factor|one.time (?:password|code)/i;
  const cdp =
    trustedSession ??
    (await page
      .context()
      .newCDPSession(page)
      .catch(() => undefined));
  if (!cdp) complete = false;
  else
    try {
      const snapshot = await cdp.send('DOM.getDocument', {
        depth: -1,
        pierce: true,
      });
      documentBackendNodeId = snapshot.root.backendNodeId;
      const pending: {
        node: SecurityNode;
        parent?: SecurityControlIdentity | undefined;
        path: string;
      }[] = [{ node: snapshot.root, path: 'root' }];
      const textParts: string[] = [];
      let count = 0;
      while (pending.length) {
        if (++count > 100000) {
          complete = false;
          break;
        }
        const { node, parent, path } = pending.pop()!;
        if (node.shadowRootType === 'user-agent') continue;
        if (['SCRIPT', 'STYLE', 'NOSCRIPT'].includes(node.nodeName)) continue;
        const attrs = new Map<string, string>();
        for (let i = 0; i < (node.attributes?.length ?? 0); i += 2)
          attrs.set(node.attributes![i]!, node.attributes![i + 1]!);
        // In the assisted flow Google owns the challenge frame. Never automate
        // its contents; inspect all employer controls around it as usual.
        if (options?.allowRecaptchaFrames && node.nodeName === 'IFRAME') {
          try {
            const src = new URL(attrs.get('src') ?? '');
            if (
              src.protocol === 'https:' &&
              !src.username &&
              !src.password &&
              ['https://www.google.com', 'https://www.recaptcha.net'].includes(
                src.origin,
              ) &&
              /^\/recaptcha\/(api2|enterprise)\//.test(src.pathname)
            ) {
              captcha = true;
              continue;
            }
          } catch {
            /* An unknown frame still fails the ordinary checks. */
          }
        }
        const stable = [
          'id',
          'name',
          'class',
          'src',
          'title',
          'aria-label',
        ].map((key) => [key, attrs.get(key) ?? '']);
        const identity = {
          backendNodeId: node.backendNodeId,
          locationDigest: digest(path),
          structuralDigest: digest(
            JSON.stringify([node.nodeName, stable, parent?.structuralDigest]),
          ),
        };
        records.push({
          id: node.backendNodeId,
          parent: parent?.backendNodeId,
          data: [
            node.backendNodeId,
            parent?.backendNodeId ?? null,
            node.nodeName,
            [...attrs].sort(([a], [b]) => a.localeCompare(b)),
            node.nodeValue,
          ],
        });
        if (node.nodeName !== '#text') identities.push(identity);
        const metadata = [...attrs.values()].join(' ');
        const signal = node.nodeName === '#text' ? node.nodeValue : metadata;
        if (node.nodeName === '#text') textParts.push(node.nodeValue);
        const isCaptcha = challenge.test(signal);
        const isAuth =
          auth.test(signal) ||
          (node.nodeName !== '#text' &&
            (/login|sign[-_]?in|authenticat|verification|\bmfa\b|\botp\b|one[-_]time[-_]code/i.test(
              metadata,
            ) ||
              (node.nodeName === 'INPUT' &&
                attrs.get('type')?.toLowerCase() === 'password')));
        const unknown =
          node.shadowRootType === 'closed' ||
          (!node.nodeName.startsWith('#') && node.nodeName.includes('-'));
        if (unknown) complete = false;
        captcha ||= isCaptcha;
        authentication ||= isAuth;
        if (isCaptcha || isAuth || unknown) {
          const control = node.nodeName === '#text' ? parent : identity;
          if (control) controls.set(control.backendNodeId, control);
          else complete = false;
        }
        if (node.nodeName === 'IFRAME' && !node.contentDocument)
          complete = false;
        const children = [
          ...(node.children ?? []),
          ...(node.shadowRoots ?? []),
          ...(node.contentDocument ? [node.contentDocument] : []),
        ];
        for (let i = children.length - 1; i >= 0; i--)
          pending.push({
            node: children[i]!,
            path: `${path}/${i}`,
            parent: node.nodeName === '#text' ? parent : identity,
          });
      }
      // Split text signals are still detected. Without a specific container,
      // resolution cannot be proven and the review remains fail-closed.
      const text = textParts.join(' ').replace(/\s+/g, ' ');
      if (!captcha && challenge.test(text)) {
        captcha = true;
        complete = false;
      }
      if (!authentication && auth.test(text)) {
        authentication = true;
        complete = false;
      }
    } catch {
      complete = false;
    } finally {
      if (!trustedSession) await cdp.detach().catch(() => {});
    }
  const ordered = [...controls.values()].sort(
    (a, b) => a.backendNodeId - b.backendNodeId,
  );
  const parents = new Map(records.map((r) => [r.id, r.parent]));
  const surrounding = records.filter((record) => {
    let cursor: number | undefined = record.id;
    for (let depth = 0; cursor !== undefined; depth++) {
      if (depth > 200) {
        complete = false;
        return false;
      }
      if (controls.has(cursor)) return false;
      cursor = parents.get(cursor);
    }
    return true;
  });
  return {
    ...(complete
      ? {
          surroundingDomDigest: digest(
            JSON.stringify(surrounding.map((r) => r.data)),
          ),
        }
      : {}),
    ...(documentBackendNodeId === undefined ? {} : { documentBackendNodeId }),
    complete,
    captcha,
    authentication,
    controls: ordered,
    nodes: identities,
    fingerprint: digest(
      JSON.stringify({ complete, captcha, authentication, controls: ordered }),
    ),
  };
}

export function reviewControlsRemoved(
  original: SecurityControlIdentity[],
  current: SecuritySnapshot,
) {
  return (
    current.complete &&
    original.length > 0 &&
    original.every(
      (old) =>
        !current.nodes.some(
          (node) =>
            node.backendNodeId === old.backendNodeId ||
            node.structuralDigest === old.structuralDigest ||
            node.locationDigest === old.locationDigest,
        ),
    )
  );
}
