import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import { ApplicationDestinationUrlSchema } from '@careerlift/domain';

export type MutationResponse = {
  responseReceivedAt: string;
  responseStatus: number;
  responseFingerprint: string;
};

export class InspectionError extends Error {
  constructor(
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'InspectionError';
  }
}

export interface BrowserNetworkPolicy {
  readonly forwardMutationsWithoutRetries?: boolean;
  auditRejectedRequest?(
    url: string,
    method: string,
    body: Buffer,
    code: string,
  ): Promise<void>;
  authorizeMutation?(
    url: string,
    method: string,
    body: Buffer,
    contentType: string,
  ): Promise<{
    beforeDispatch(): Promise<void>;
    complete(
      outcome: 'REJECTED' | 'FORWARDED' | 'UNKNOWN',
      response?: MutationResponse,
    ): Promise<void>;
  }>;
  validateNavigation(url: string): void;
  validateRequest(url: string, method: string): void;
  validateAddress(url: string): Promise<void>;
  validateConnectedAddress(url: string, address: string): void;
}

export type AddressResolver = (hostname: string) => Promise<string[]>;
const systemResolver: AddressResolver = async (hostname) =>
  (await lookup(hostname, { all: true, verbatim: true })).map(
    (entry) => entry.address,
  );

export function isPublicAddress(address: string): boolean {
  const kind = isIP(address);
  if (kind === 4) {
    const [a = 0, b = 0, c = 0] = address.split('.').map(Number);
    return !(
      a === 0 ||
      a === 10 ||
      a === 127 ||
      a >= 224 ||
      (a === 100 && b >= 64 && b <= 127) ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      (a === 192 && b === 0 && c === 0) ||
      (a === 192 && b === 0 && c === 2) ||
      (a === 198 && (b === 18 || b === 19)) ||
      (a === 198 && b === 51 && c === 100) ||
      (a === 203 && b === 0 && c === 113)
    );
  }
  if (kind === 6) {
    const normalized = address.toLowerCase();
    const tail = normalized.match(/(?:\d+\.){3}\d+$/)?.[0];
    if (
      tail &&
      (normalized.startsWith('::ffff:') || normalized.startsWith('::'))
    )
      return isPublicAddress(tail);
    if (normalized.startsWith('::ffff:')) {
      const pieces = normalized.slice(7).split(':');
      if (pieces.length === 2) {
        const high = Number.parseInt(pieces[0] ?? '', 16);
        const low = Number.parseInt(pieces[1] ?? '', 16);
        if (Number.isFinite(high) && Number.isFinite(low))
          return isPublicAddress(
            [high >> 8, high & 255, low >> 8, low & 255].join('.'),
          );
      }
    }
    const first = Number.parseInt(normalized.split(':')[0] || '0', 16);
    return !(
      normalized === '::' ||
      normalized === '::1' ||
      (first & 0xfe00) === 0xfc00 ||
      (first & 0xffc0) === 0xfe80 ||
      (first & 0xff00) === 0xff00 ||
      normalized.startsWith('2001:db8:')
    );
  }
  return false;
}

export class DestinationPolicy implements BrowserNetworkPolicy {
  constructor(
    private readonly localFixtureOrigin?: string,
    private readonly resolveAddresses: AddressResolver = systemResolver,
  ) {
    if (localFixtureOrigin) {
      const url = new URL(localFixtureOrigin);
      if (
        !['http:', 'https:'].includes(url.protocol) ||
        !['127.0.0.1', '[::1]', 'localhost'].includes(url.hostname) ||
        url.origin !== localFixtureOrigin
      )
        throw new InspectionError(
          'INVALID_FIXTURE_ORIGIN',
          'Fixture origin must be an exact loopback origin',
        );
    }
  }

  private fixture(url: URL): boolean {
    return Boolean(
      this.localFixtureOrigin &&
      url.origin === this.localFixtureOrigin &&
      ['http:', 'https:'].includes(url.protocol),
    );
  }

  validateNavigation(url: string): void {
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      throw new InspectionError(
        'UNSAFE_DESTINATION',
        'Invalid destination URL',
      );
    }
    if (
      !this.fixture(parsed) &&
      !ApplicationDestinationUrlSchema.safeParse(url).success
    )
      throw new InspectionError(
        'UNSAFE_DESTINATION',
        'Destination is not an approved HTTPS URL',
      );
    if (
      parsed.username ||
      parsed.password ||
      !parsed.hostname ||
      parsed.hostname.endsWith('.')
    )
      throw new InspectionError(
        'UNSAFE_DESTINATION',
        'Unsafe destination hostname',
      );
    const host = parsed.hostname.toLowerCase().replace(/^\[|\]$/g, '');
    if (
      !this.fixture(parsed) &&
      (host === 'localhost' ||
        host.endsWith('.localhost') ||
        host.endsWith('.local') ||
        host.endsWith('.internal') ||
        host === 'metadata.google.internal' ||
        host === 'metadata' ||
        (isIP(host) > 0 && !isPublicAddress(host)))
    )
      throw new InspectionError(
        'UNSAFE_DESTINATION',
        'Private or metadata destination',
      );
  }

  validateRequest(url: string, method: string): void {
    if (method !== 'GET' && method !== 'HEAD')
      throw new InspectionError(
        'MUTATING_REQUEST_BLOCKED',
        'Read-only inspection blocks non-read requests',
      );
    this.validateNavigation(url);
  }

  async validateAddress(url: string): Promise<void> {
    this.validateNavigation(url);
    const parsed = new URL(url);
    if (this.fixture(parsed)) return;
    const host = parsed.hostname.replace(/^\[|\]$/g, '');
    let addresses: string[];
    try {
      addresses = isIP(host) ? [host] : await this.resolveAddresses(host);
    } catch {
      throw new InspectionError('DNS_FAILURE', 'Destination DNS lookup failed');
    }
    if (
      !addresses.length ||
      addresses.some((address) => !isPublicAddress(address))
    )
      throw new InspectionError(
        'UNSAFE_DESTINATION',
        'Destination resolves to a non-public address',
      );
  }

  validateConnectedAddress(url: string, address: string): void {
    if (!this.fixture(new URL(url)) && !isPublicAddress(address))
      throw new InspectionError(
        'UNSAFE_DESTINATION',
        'Browser connected to a non-public address',
      );
  }
}

export function validateRedirectChain(
  chain: string[],
  policy: BrowserNetworkPolicy,
): void {
  if (chain.length > 20)
    throw new InspectionError('TOO_MANY_REDIRECTS', 'Redirect limit exceeded');
  for (const url of chain) policy.validateNavigation(url);
}
