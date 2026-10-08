import type { ExecutionInput } from '@careerlift/domain';
import {
  bindContract,
  validatePayload,
  type MutationContract,
} from './mutation-contract.js';
import {
  DestinationPolicy,
  InspectionError,
  type BrowserNetworkPolicy,
  type MutationResponse,
} from './policy.js';

export class ExecutionNetworkPolicy implements BrowserNetworkPolicy {
  readonly forwardMutationsWithoutRetries = true;
  private mutation:
    | {
        contract: MutationContract;
        audit: (
          outcome: 'REJECTED' | 'DISPATCHING' | 'FORWARDED' | 'UNKNOWN',
          response?: MutationResponse,
        ) => Promise<void>;
        fence: () => Promise<void>;
      }
    | undefined;
  private readonly finalDestinations: Set<string>;
  private binding: Pick<
    MutationContract,
    'applicationId' | 'executionId' | 'userId' | 'runId' | 'generation'
  >;
  private readonly canonicalApplicationUrl: string;
  private finalAuthorityCreated = false;
  private dispatchBound: boolean;
  private expiresAt = 0;
  private readonly nextActions: NonNullable<
    ExecutionInput['inspection']['executionFlow']
  >['pages'][number]['nextRequest'][];
  rebindDispatch(input: ExecutionInput) {
    const binding = bindContract(
      input,
      'binding',
      'FINAL_SUBMIT',
      input.inspection.finalUrl,
      'POST',
      [],
    );
    if (
      binding.applicationId !== this.binding.applicationId ||
      binding.executionId !== this.binding.executionId ||
      binding.userId !== this.binding.userId ||
      binding.generation < this.binding.generation ||
      (binding.generation === this.binding.generation &&
        binding.runId !== this.binding.runId) ||
      this.mutation ||
      this.finalAuthorityCreated
    )
      throw new InspectionError(
        'MUTATION_BINDING_CHANGED',
        'Retained dispatch identity cannot be transferred',
      );
    this.binding = binding;
    this.dispatchBound =
      Boolean(input.dispatchIdentity) || input.mode !== 'REAL_EXECUTION';
  }
  private assetsAllowed = true;
  private rejectionAuditor:
    ((url: string, method: string, body: Buffer) => Promise<void>) | undefined;
  setRejectionAuditor(
    auditor: NonNullable<ExecutionNetworkPolicy['rejectionAuditor']>,
  ) {
    this.rejectionAuditor = auditor;
  }
  async auditRejectedRequest(
    url: string,
    method: string,
    body: Buffer,
    code: string,
  ) {
    if (
      !['GET', 'HEAD'].includes(method) &&
      [
        'MUTATING_REQUEST_BLOCKED',
        'UNEXPECTED_RESOURCE_ORIGIN',
        'UNEXPECTED_NAVIGATION',
        'UNSAFE_DESTINATION',
      ].includes(code)
    )
      await this.rejectionAuditor?.(url, method, body);
  }
  private readonly urls: Set<string>;
  private readonly origins: Set<string>;
  constructor(
    input: ExecutionInput,
    private readonly base: BrowserNetworkPolicy = new DestinationPolicy(),
  ) {
    const flow = input.inspection.executionFlow;
    // API navigation preflight runs before a worker run ID exists. It grants no dispatch authority.
    this.binding = {
      applicationId: input.applicationId,
      executionId: input.executionId,
      userId:
        input.dispatchIdentity?.userId ?? input.ownerId ?? 'LOCAL_FIXTURE',
      runId: input.dispatchIdentity?.runId ?? input.executionId,
      generation: input.dispatchIdentity?.generation ?? 1,
    };
    this.dispatchBound =
      Boolean(input.dispatchIdentity) || input.mode !== 'REAL_EXECUTION';
    this.canonicalApplicationUrl = input.inspection.finalUrl;
    this.nextActions =
      flow?.pages.map((p) => p.nextRequest).filter(Boolean) ?? [];
    this.finalDestinations = new Set(
      flow?.pages
        .filter((p) => p.action === 'SUBMIT')
        .map((p) => p.control.actionUrl),
    );
    this.urls = new Set([
      input.plan.destination.url!,
      input.inspection.finalUrl,
      ...input.inspection.redirectChain,
      ...(flow?.pages.flatMap((p) => [
        p.url,
        p.expectedUrl,
        p.control.actionUrl,
        ...(p.nextRequest ? [p.nextRequest.destination] : []),
      ]) ?? []),
    ]);
    // Execution flow must stay within the inspected application origin.
    this.origins = new Set([new URL(input.inspection.finalUrl).origin]);
    for (const url of this.urls) {
      base.validateNavigation(url);
      if (!this.origins.has(new URL(url).origin))
        throw new InspectionError(
          'FLOW_ORIGIN_CHANGED',
          'Cross-origin execution flow requires review',
        );
    }
  }
  allowMutation(
    contract: MutationContract,
    durableState: string,
    audit: NonNullable<ExecutionNetworkPolicy['mutation']>['audit'],
    fence: () => Promise<void>,
  ) {
    this.validateNavigation(contract.destination);
    if (!this.dispatchBound)
      throw new InspectionError(
        'DISPATCH_IDENTITY_REQUIRED',
        'Navigation preflight cannot authorize a mutation',
      );
    if (
      contract.applicationId !== this.binding.applicationId ||
      contract.executionId !== this.binding.executionId ||
      contract.userId !== this.binding.userId ||
      contract.runId !== this.binding.runId ||
      contract.generation !== this.binding.generation ||
      contract.externalIdentity.canonicalApplicationUrl !==
        this.canonicalApplicationUrl ||
      !contract.actionId
    )
      throw new InspectionError(
        'MUTATION_BINDING_CHANGED',
        'Mutation does not belong to this dispatch',
      );
    if (
      this.mutation ||
      (contract.action === 'FINAL_SUBMIT' && durableState !== 'SUBMITTING')
    )
      throw new InspectionError(
        'INVALID_MUTATION_AUTHORITY',
        'Final authority requires the durable submission barrier',
      );
    if (
      contract.action === 'NEXT' &&
      this.finalDestinations.has(contract.destination)
    )
      throw new InspectionError(
        'AMBIGUOUS_NEXT_MUTATION',
        'Next cannot authorize a final endpoint',
      );
    if (
      contract.action === 'FINAL_SUBMIT' &&
      (this.finalAuthorityCreated ||
        !this.finalDestinations.has(contract.destination) ||
        contract.method !== 'POST')
    )
      throw new InspectionError(
        'INVALID_MUTATION_AUTHORITY',
        'Final authority is single-use and restricted to the final control',
      );
    if (
      contract.action === 'NEXT' &&
      (durableState !== 'RUNNING' ||
        !this.nextActions.some(
          (next) =>
            next &&
            next.destination === contract.destination &&
            next.method === contract.method &&
            next.discriminator.value !== next.discriminator.finalValue &&
            contract.fields.some(
              (field) =>
                field.kind === 'STATIC_APPROVED_FIELD' &&
                field.name === next.discriminator.name &&
                field.value === next.discriminator.value,
            ),
        ))
    )
      throw new InspectionError(
        'INVALID_MUTATION_AUTHORITY',
        'Next requires its explicit action discriminator',
      );
    if (contract.action === 'FINAL_SUBMIT') this.finalAuthorityCreated = true;
    this.expiresAt = Date.now() + 15000;
    this.mutation = { contract: structuredClone(contract), audit, fence };
  }
  async authorizeMutation(
    url: string,
    method: string,
    body: Buffer,
    contentType: string,
  ) {
    const permit = this.mutation;
    this.mutation = undefined; // Claim before any asynchronous work; competing requests cannot reuse authority.
    if (
      !permit ||
      permit.contract.destination !== url ||
      permit.contract.method !== method ||
      Date.now() > this.expiresAt
    )
      throw new InspectionError(
        'MUTATING_REQUEST_BLOCKED',
        'No matching request authority',
      );
    try {
      await validatePayload(permit.contract, body, contentType);
    } catch (error) {
      await permit.audit('REJECTED');
      throw error;
    }
    return {
      beforeDispatch: async () => {
        if (Date.now() > this.expiresAt)
          throw new InspectionError(
            'MUTATION_AUTHORITY_EXPIRED',
            'Dispatch authority expired',
          );
        await permit.audit('DISPATCHING');
        await permit.fence();
      },
      complete: permit.audit,
    };
  }
  closeMutation() {
    this.mutation = undefined;
  }
  sealReads() {
    this.assetsAllowed = false;
  }
  validateNavigation(url: string) {
    this.base.validateNavigation(url);
    if (!this.urls.has(url))
      throw new InspectionError(
        'UNEXPECTED_NAVIGATION',
        'Navigation outside inspected flow',
      );
  }
  validateRequest(url: string, method: string) {
    this.base.validateNavigation(url);
    if (!this.origins.has(new URL(url).origin))
      throw new InspectionError(
        'UNEXPECTED_RESOURCE_ORIGIN',
        'Unexpected resource origin',
      );
    if (
      ['GET', 'HEAD'].includes(method) &&
      !this.urls.has(url) &&
      (!this.assetsAllowed ||
        !/\.(?:css|js|mjs|png|jpg|jpeg|gif|svg|webp|ico|woff2?|ttf)$/i.test(
          new URL(url).pathname,
        ))
    )
      throw new InspectionError(
        'UNEXPECTED_READ_REQUEST',
        'Read request outside inspected flow or initial static assets',
      );
    if (
      method !== 'GET' &&
      method !== 'HEAD' &&
      (url !== this.mutation?.contract.destination ||
        method !== this.mutation.contract.method)
    )
      throw new InspectionError(
        'MUTATING_REQUEST_BLOCKED',
        'Mutation outside explicit action',
      );
  }
  async validateAddress(url: string) {
    await this.base.validateAddress(url);
  }
  validateConnectedAddress(url: string, address: string) {
    this.base.validateConnectedAddress(url, address);
  }
}
