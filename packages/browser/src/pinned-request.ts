import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import { request as httpsRequest } from 'node:https';
import { InspectionError, type BrowserNetworkPolicy } from './policy.js';

// Trusted adapter transport: one connection, no redirects, no automatic retries.
export async function pinnedPost(
  destination: string,
  body: Uint8Array,
  contentType: string,
  policy: BrowserNetworkPolicy,
  beforeDispatch: () => Promise<void>,
  ignoreHTTPSErrors = false,
) {
  const url = new URL(destination),
    host = url.hostname.replace(/^\[|\]$/g, '');
  if (url.protocol !== 'https:')
    throw new InspectionError('UNSAFE_DESTINATION', 'HTTPS is required');
  await policy.validateAddress(url.href);
  const addresses = isIP(host)
    ? [{ address: host, family: isIP(host) }]
    : await lookup(host, { all: true, verbatim: true });
  if (!addresses.length)
    throw new InspectionError('DNS_FAILURE', 'No destination address');
  for (const a of addresses)
    policy.validateConnectedAddress(url.href, a.address);
  if (body.length > 50 * 1024 * 1024)
    throw new InspectionError(
      'MUTATION_BODY_TOO_LARGE',
      'Payload is too large',
    );
  return new Promise<{ status: number; body: Buffer }>((resolve, reject) => {
    const req = httpsRequest(
      {
        hostname: addresses[0]!.address,
        port: url.port || 443,
        servername: isIP(host) ? '' : host,
        path: url.pathname + url.search,
        method: 'POST',
        headers: {
          host: url.host,
          'content-type': contentType,
          'content-length': String(body.length),
          connection: 'close',
        },
        rejectUnauthorized: !ignoreHTTPSErrors,
        timeout: 15000,
      },
      (res) => {
        const chunks: Buffer[] = [];
        let size = 0;
        res.on('data', (chunk: Buffer) => {
          size += chunk.length;
          if (size > 2 * 1024 * 1024)
            res.destroy(
              new InspectionError(
                'MUTATION_RESPONSE_TOO_LARGE',
                'Response is too large',
              ),
            );
          else chunks.push(chunk);
        });
        res.on('error', reject);
        res.on('end', () =>
          resolve({
            status: res.statusCode ?? 502,
            body: Buffer.concat(chunks),
          }),
        );
      },
    );
    req.on('error', reject);
    req.on('timeout', () =>
      req.destroy(new InspectionError('MUTATION_TIMEOUT', 'Request timed out')),
    );
    req.on('socket', (socket) =>
      socket.once('secureConnect', () => {
        void (async () => {
          policy.validateConnectedAddress(url.href, socket.remoteAddress ?? '');
          await beforeDispatch();
          if (req.destroyed)
            throw new InspectionError(
              'MUTATION_TIMEOUT',
              'Connection closed before dispatch',
            );
          req.end(body);
        })().catch((error) => req.destroy(error));
      }),
    );
  });
}
