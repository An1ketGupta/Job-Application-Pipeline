import { lookup } from 'node:dns/promises';
import { createHash } from 'node:crypto';
import { isIP } from 'node:net';
import { request as httpsRequest } from 'node:https';
import { request as httpRequest } from 'node:http';
import type { Route } from 'playwright';
import {
  InspectionError,
  type BrowserNetworkPolicy,
  type MutationResponse,
} from './policy.js';

// A browser can transparently resend POST on connection reset. Use one pinned
// connection and no redirects/retries, while sharing the session's address policy.
export async function forwardMutationOnce(
  route: Route,
  policy: BrowserNetworkPolicy,
  ignoreHTTPSErrors: boolean,
) {
  const browserRequest = route.request();
  const url = new URL(browserRequest.url());
  const host = url.hostname.replace(/^\[|\]$/g, '');
  const body = browserRequest.postDataBuffer() ?? Buffer.alloc(0);
  const headers = await browserRequest.allHeaders();
  if (!policy.authorizeMutation)
    throw new InspectionError(
      'MUTATION_CONTRACT_REQUIRED',
      'Payload authorization is required',
    );
  const authorization = await policy.authorizeMutation(
    url.href,
    browserRequest.method(),
    body,
    headers['content-type'] ?? '',
  );
  let dispatched = false;
  let observation: MutationResponse | undefined;
  try {
    const addresses = isIP(host)
      ? [{ address: host, family: isIP(host) }]
      : await lookup(host, { all: true, verbatim: true });
    if (!addresses.length)
      throw new InspectionError(
        'DNS_FAILURE',
        'No mutation destination address',
      );
    for (const address of addresses)
      policy.validateConnectedAddress(url.href, address.address);
    const address = addresses[0]!;
    if (body.length > 50 * 1024 * 1024)
      throw new InspectionError(
        'MUTATION_BODY_TOO_LARGE',
        'Mutation payload too large',
      );
    // Keep the original authority for Host and TLS, but connect to the validated IP.
    const response = await new Promise<{
      status: number;
      headers: Record<string, string>;
      body: Buffer;
    }>((resolve, reject) => {
      const request = (url.protocol === 'https:' ? httpsRequest : httpRequest)(
        {
          protocol: url.protocol,
          hostname: address.address,
          port: url.port || (url.protocol === 'https:' ? 443 : 80),
          path: `${url.pathname}${url.search}`,
          method: browserRequest.method(),
          headers: {
            ...headers,
            host: url.host,
            'content-length': String(body.length),
            connection: 'close',
          },
          servername: isIP(host) ? '' : host,
          rejectUnauthorized: !ignoreHTTPSErrors,
          timeout: 15000,
        },
        (incoming) => {
          const chunks: Buffer[] = [];
          let size = 0;
          incoming.on('data', (chunk: Buffer) => {
            size += chunk.length;
            if (size > 2 * 1024 * 1024) {
              incoming.destroy();
              reject(
                new InspectionError(
                  'MUTATION_RESPONSE_TOO_LARGE',
                  'Mutation response too large',
                ),
              );
            } else chunks.push(chunk);
          });
          incoming.on('error', reject);
          incoming.on('end', () => {
            const responseHeaders: Record<string, string> = {};
            for (const [key, value] of Object.entries(incoming.headers))
              if (value !== undefined)
                responseHeaders[key] = Array.isArray(value)
                  ? value.join('\n')
                  : value;
            // Node leaves compressed response bytes intact; preserve content-encoding.
            resolve({
              status: incoming.statusCode ?? 502,
              headers: responseHeaders,
              body: Buffer.concat(chunks),
            });
          });
        },
      );
      request.on('error', reject);
      request.on('timeout', () =>
        request.destroy(
          new InspectionError(
            'MUTATION_TIMEOUT',
            'Mutation connection timed out',
          ),
        ),
      );
      request.on('socket', (socket) => {
        socket.once(
          url.protocol === 'https:' ? 'secureConnect' : 'connect',
          async () => {
            try {
              policy.validateConnectedAddress(
                url.href,
                socket.remoteAddress ?? '',
              );
              await authorization.beforeDispatch();
              if (request.destroyed)
                throw new InspectionError(
                  'MUTATION_TIMEOUT',
                  'Dispatch connection closed',
                );
              dispatched = true;
              request.end(body);
            } catch (error) {
              request.destroy();
              reject(error);
            }
          },
        );
      });
    });
    observation = {
      responseReceivedAt: new Date().toISOString(),
      responseStatus: response.status,
      responseFingerprint: createHash('sha256')
        .update(response.body)
        .digest('hex'),
    };
    const location = response.headers['location'];
    if (response.status >= 300 && response.status < 400 && location)
      policy.validateNavigation(new URL(location, url).href);
    await authorization.complete('FORWARDED', observation);
    await route.fulfill(response);
  } catch (error) {
    await authorization.complete(
      dispatched ? 'UNKNOWN' : 'REJECTED',
      observation,
    );
    throw error;
  }
}
