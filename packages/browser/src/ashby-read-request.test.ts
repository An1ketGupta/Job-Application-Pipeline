import { createServer } from 'node:http';
import { describe, expect, it } from 'vitest';
import {
  isAshbyReadRequest,
  isOptionalAshbyTelemetry,
} from './ashby-read-request.js';
import { BrowserSessionManager } from './session.js';
import { DestinationPolicy } from './policy.js';

const source = 'https://jobs.ashbyhq.com/elevenlabs/posting/application';
const requestUrl =
  'https://jobs.ashbyhq.com/api/non-user-graphql?op=ApiJobPosting';
const input = {
  operationName: 'ApiJobPosting',
  variables: {
    organizationHostedJobsPageName: 'elevenlabs',
    jobPostingId: 'posting',
  },
  query:
    'query ApiJobPosting($organizationHostedJobsPageName: String!, $jobPostingId: String!) { jobPosting(organizationHostedJobsPageName: $organizationHostedJobsPageName, jobPostingId: $jobPostingId) { id applicationForm { id } } }',
};
const check = (payload: unknown, url = requestUrl) =>
  isAshbyReadRequest(
    source,
    url,
    'POST',
    Buffer.from(JSON.stringify(payload)),
    'application/json',
  );
describe('Ashby inspection read requests', () => {
  it('accepts only public metadata queries scoped to the inspected posting', () => {
    expect(check(input)).toBe(true);
    const organization = {
      operationName: 'ApiOrganizationFromHostedJobsPageName',
      variables: { organizationHostedJobsPageName: 'elevenlabs' },
      query:
        'query ApiOrganizationFromHostedJobsPageName($organizationHostedJobsPageName: String!, $searchContext: OrganizationSearchContext) { organization: organizationFromHostedJobsPageName(organizationHostedJobsPageName: $organizationHostedJobsPageName, searchContext: $searchContext) { name } }',
    };
    expect(
      check(
        organization,
        requestUrl.replace('ApiJobPosting', organization.operationName),
      ),
    ).toBe(true);
    const countries = {
      operationName: 'ApiAutocompleteGeoLocation',
      variables: { text: '', locationTypes: ['Country'] },
      query:
        'query ApiAutocompleteGeoLocation($text: String!, $locationTypes: [GeoLocationType!]) { autocompleteGeoLocation(text: $text, locationTypes: $locationTypes) { suggestions { name } } }',
    };
    expect(
      check(
        countries,
        requestUrl.replace('ApiJobPosting', countries.operationName),
      ),
    ).toBe(true);
    expect(
      check(
        {
          ...countries,
          variables: { text: 'candidate data', locationTypes: ['Country'] },
        },
        requestUrl.replace('ApiJobPosting', countries.operationName),
      ),
    ).toBe(false);
  });
  it.each([
    {
      ...input,
      query: input.query.replace(
        'query ApiJobPosting',
        'mutation ApiJobPosting',
      ),
    },
    {
      ...input,
      query: input.query.replace('jobPosting(', 'submitApplication('),
    },
    {
      ...input,
      query: input.query.replace(
        '{ id applicationForm { id } } }',
        '{ id } submitApplication { id } }',
      ),
    },
    {
      ...input,
      query: input.query + ' mutation Submit { submitApplication { id } }',
    },
    { ...input, query: input.query + ' query Another { jobPosting { id } }' },
    {
      ...input,
      query: input.query.replace('$jobPostingId)', '"another-posting")'),
    },
    {
      ...input,
      query: input.query.replace(
        '$jobPostingId: String!',
        '$jobPostingId: String! = "another-posting"',
      ),
    },
    {
      ...input,
      variables: { ...input.variables, jobPostingId: 'another-posting' },
    },
    {
      ...input,
      variables: {
        ...input.variables,
        organizationHostedJobsPageName: 'another-org',
      },
    },
    { ...input, variables: { ...input.variables, resume: 'candidate-data' } },
    { ...input, extensions: { persistedQuery: 'another-operation' } },
    { ...input, query: 'invalid graphql' },
    [input],
    null,
  ])('rejects altered payloads %j', (payload) =>
    expect(check(payload)).toBe(false),
  );
  it.each([
    'https://other.example/api/non-user-graphql?op=ApiJobPosting',
    'http://jobs.ashbyhq.com/api/non-user-graphql?op=ApiJobPosting',
    'https://jobs.ashbyhq.com/api/submit?op=ApiJobPosting',
    requestUrl + '&op=ApiJobPosting',
    requestUrl + '&extra=value',
    requestUrl.replace('ApiJobPosting', 'SubmitApplication'),
  ])('rejects unapproved endpoint %s', (url) =>
    expect(check(input, url)).toBe(false),
  );
  it('rejects other platforms, malformed bodies, oversized payloads and non-JSON requests', () => {
    const body = Buffer.from(JSON.stringify(input));
    expect(
      isAshbyReadRequest(
        'https://jobs.lever.co/elevenlabs/posting/apply',
        requestUrl,
        'POST',
        body,
        'application/json',
      ),
    ).toBe(false);
    expect(
      isAshbyReadRequest(source, requestUrl, 'PUT', body, 'application/json'),
    ).toBe(false);
    expect(
      isAshbyReadRequest(source, requestUrl, 'POST', body, 'text/plain'),
    ).toBe(false);
    expect(
      isAshbyReadRequest(
        source,
        requestUrl,
        'POST',
        Buffer.from('{'),
        'application/json',
      ),
    ).toBe(false);
    expect(
      isAshbyReadRequest(
        source,
        requestUrl,
        'POST',
        Buffer.alloc(65537),
        'application/json',
      ),
    ).toBe(false);
  });
  it('only identifies the known optional analytics endpoint for suppression', () => {
    expect(
      isOptionalAshbyTelemetry(
        source,
        'https://browser-intake-datadoghq.com/api/v2/rum',
        'POST',
      ),
    ).toBe(true);
    for (const url of [
      requestUrl,
      'https://other.example/api/v2/rum',
      'https://browser-intake-datadoghq.com/api/submit',
    ])
      expect(isOptionalAshbyTelemetry(source, url, 'POST')).toBe(false);
  });
  it('forwards validated reads, drops optional telemetry, and refuses submissions through the real session policy', async () => {
    const received: string[] = [];
    const server = createServer((request, response) => {
      received.push(request.url!);
      response.setHeader(
        'content-type',
        request.url === '/' ? 'text/html' : 'application/json',
      );
      response.end(request.url === '/' ? '<title>Fixture</title>' : '{}');
    });
    await new Promise<void>((resolve) =>
      server.listen(0, '127.0.0.1', resolve),
    );
    const address = server.address();
    if (!address || typeof address === 'string')
      throw new Error('Missing fixture address');
    const origin = `http://127.0.0.1:${address.port}`;
    // Transport is local; the guard validates payloads against the public identity.
    const session = await new BrowserSessionManager(
      true,
      new DestinationPolicy(origin),
    ).create(undefined, (url, method, body, contentType) => {
      const path = new URL(url).pathname;
      if (path === '/telemetry') return 'BLOCK_OPTIONAL';
      return isAshbyReadRequest(
        source,
        url.replace(origin, 'https://jobs.ashbyhq.com'),
        method,
        body,
        contentType,
      );
    });
    try {
      await session.page.goto(origin);
      const read = await session.page.evaluate(
        async ({ input }) => {
          const response = await fetch(
            '/api/non-user-graphql?op=ApiJobPosting',
            {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify(input),
            },
          );
          return response.status;
        },
        { input },
      );
      expect(read).toBe(200);
      await session.page.evaluate(() =>
        fetch('/telemetry', { method: 'POST', body: 'tracking' }).catch(
          () => {},
        ),
      );
      await session.securityCheck();
      expect(received).not.toContain('/telemetry');
      expect(session.securitySnapshot().violations).toBe(0);
      await session.page.evaluate(() =>
        fetch('/submit', { method: 'POST', body: 'candidate' }).catch(() => {}),
      );
      await expect(session.securityCheck()).rejects.toMatchObject({
        code: 'MUTATING_REQUEST_BLOCKED',
      });
      expect(received).not.toContain('/submit');
      expect(received).toContain('/api/non-user-graphql?op=ApiJobPosting');
    } finally {
      await session.close();
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    }
  }, 15000);
});
