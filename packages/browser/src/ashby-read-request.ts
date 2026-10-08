import { Kind, OperationTypeNode, parse } from 'graphql';
import { atsUrlIdentity } from '@careerlift/domain';

// Ashby's public job, organization, and country queries use POST even though they only
// read metadata. Authorize the parsed query and exact posting, never the verb
// or operation name alone. All navigation/DNS/address checks still apply.
export function isAshbyReadRequest(
  sourceUrl: string,
  requestUrl: string,
  method: string,
  body: Buffer,
  contentType: string,
  fixtureOrigin?: string,
): boolean {
  const target = atsUrlIdentity(sourceUrl);
  if (
    target?.platform !== 'ASHBY' ||
    method !== 'POST' ||
    !/^application\/json(?:\s*;|$)/i.test(contentType) ||
    body.length > 65536
  )
    return false;
  try {
    const url = new URL(requestUrl);
    if (
      url.origin !== (fixtureOrigin ?? new URL(target.canonicalUrl).origin) ||
      url.pathname !== '/api/non-user-graphql' ||
      url.username ||
      url.password ||
      url.hash ||
      Array.from(url.searchParams.keys()).length !== 1
    )
      return false;
    const input = JSON.parse(body.toString('utf8'));
    if (
      !input ||
      typeof input !== 'object' ||
      Array.isArray(input) ||
      Object.keys(input).some(
        (k) => !['query', 'operationName', 'variables'].includes(k),
      ) ||
      typeof input.query !== 'string' ||
      input.operationName !== url.searchParams.get('op')
    )
      return false;
    const organization =
      input.operationName === 'ApiOrganizationFromHostedJobsPageName';
    const countries = input.operationName === 'ApiAutocompleteGeoLocation';
    if (!organization && !countries && input.operationName !== 'ApiJobPosting')
      return false;
    const variables = input.variables;
    const allowed = organization
      ? ['organizationHostedJobsPageName', 'searchContext']
      : countries
        ? ['text', 'locationTypes']
        : ['organizationHostedJobsPageName', 'jobPostingId'];
    if (
      !variables ||
      typeof variables !== 'object' ||
      Array.isArray(variables) ||
      Object.keys(variables).some((k) => !allowed.includes(k)) ||
      (countries
        ? variables.text !== '' ||
          !Array.isArray(variables.locationTypes) ||
          variables.locationTypes.length !== 1 ||
          variables.locationTypes[0] !== 'Country'
        : variables.organizationHostedJobsPageName !== target.boardToken ||
          (organization
            ? variables.searchContext != null &&
              variables.searchContext !== 'JobPosting'
            : variables.jobPostingId !== target.externalJobId))
    )
      return false;
    const document = parse(input.query, { noLocation: true, maxTokens: 5000 });
    const operations = document.definitions.filter(
      (d) => d.kind === Kind.OPERATION_DEFINITION,
    );
    if (
      operations.length !== 1 ||
      document.definitions.some(
        (d) =>
          d.kind !== Kind.OPERATION_DEFINITION &&
          d.kind !== Kind.FRAGMENT_DEFINITION,
      )
    )
      return false;
    const operation = operations[0]!;
    if (
      operation.operation !== OperationTypeNode.QUERY ||
      operation.name?.value !== input.operationName ||
      operation.selectionSet.selections.length !== 1 ||
      operation.directives?.length
    )
      return false;
    const root = operation.selectionSet.selections[0]!;
    if (
      root.kind !== Kind.FIELD ||
      root.name.value !==
        (organization
          ? 'organizationFromHostedJobsPageName'
          : countries
            ? 'autocompleteGeoLocation'
            : 'jobPosting') ||
      root.directives?.length ||
      root.arguments?.length !== allowed.length
    )
      return false;
    return (
      allowed.every(
        (name) =>
          root.arguments?.filter(
            (a) =>
              a.name.value === name &&
              a.value.kind === Kind.VARIABLE &&
              a.value.name.value === name,
          ).length === 1,
      ) &&
      operation.variableDefinitions?.length === allowed.length &&
      operation.variableDefinitions.every(
        (v) => allowed.includes(v.variable.name.value) && !v.defaultValue,
      )
    );
  } catch {
    return false;
  }
}

// Optional analytics must never be sent during inspection. Dropping this known
// tracking endpoint does not prevent the application form from being inspected.
export function isOptionalAshbyTelemetry(
  sourceUrl: string,
  requestUrl: string,
  method: string,
): boolean {
  if (atsUrlIdentity(sourceUrl)?.platform !== 'ASHBY' || method !== 'POST')
    return false;
  try {
    const url = new URL(requestUrl);
    return (
      url.origin === 'https://browser-intake-datadoghq.com' &&
      url.pathname === '/api/v2/rum' &&
      !url.username &&
      !url.password &&
      !url.hash
    );
  } catch {
    return false;
  }
}
