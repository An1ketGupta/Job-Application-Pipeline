import { createServer } from 'node:https';
import { once } from 'node:events';
import {
  ApplicationPlanSchema,
  ApplicationSchemaSchema,
  ExecutionInputSchema,
  type ExecutionInput,
  type DocumentStorage,
} from '@careerlift/domain';
import { testKey, testCert } from './ashby-test-tls.js';
import { digest } from '../mutation-contract.js';

export function ashbyPosting(captcha = false) {
  return {
    id: 'posting',
    recaptchaAction: captcha ? 'job_apply' : null,
    surveyForms: [],
    applicationForm: {
      id: 'render',
      sourceFormDefinitionId: 'definition',
      formControls: [{ identifier: 'submit-action', title: 'Submit' }],
      sections: [
        {
          isHidden: null,
          fieldEntries: [
            {
              id: 'render_name',
              isRequired: true,
              isHidden: null,
              field: {
                path: 'name',
                title: 'Name',
                type: 'String',
                selectableValues: null,
              },
            },
            {
              id: 'render_email',
              isRequired: true,
              field: { path: 'email', title: 'Email', type: 'Email' },
            },
            {
              id: 'render_resume',
              isRequired: true,
              field: { path: 'resume', title: 'Resume', type: 'File' },
            },
          ],
        },
      ],
    },
  };
}

export function ashbyInput(origin: string): ExecutionInput {
  const url = `${origin}/fixture/posting/application`,
    source = 'https://jobs.ashbyhq.com/fixture/posting/application';
  const plan = ApplicationPlanSchema.parse({
    jobId: 'job',
    applicationType: 'EXTERNAL_ATS',
    provider: 'ASHBY',
    destination: {
      url,
      target: {
        platform: 'ASHBY',
        adapterVersion: 1,
        canonicalUrl: url,
        boardToken: 'fixture',
        externalJobId: 'posting',
        company: 'Fixture',
        role: 'Engineer',
        metadataSource: 'JOB_UNTRUSTED',
        entryPoint: { url, kind: 'APPLICATION_ROUTE' },
        fixtureSourceUrl: source,
        capabilities: {
          supportsFileUpload: true,
          supportsResumeUpload: true,
          supportsCoverLetter: true,
          supportsDynamicQuestions: true,
          supportsMultiStepForms: true,
          supportsKnownSuccessSignals: false,
        },
        inspectionHints: {
          formIsDynamic: true,
          navigation: 'APPLICATION_ROUTE',
        },
      },
    },
    requirements: [],
    actions: [],
    executor: 'BROWSER',
    confidence: 1,
    requiresHumanReview: false,
    reasoning: [],
    resolvedBy: 'deterministic',
  });
  const at = new Date().toISOString();
  const fields = [
    ['name', 'Name', 'TEXT'],
    ['email', 'Email', 'EMAIL'],
    ['resume', 'Resume', 'FILE'],
  ].map(([id, label, type]) => ({
    id,
    domId: id,
    label,
    type,
    required: true,
    visible: true,
    disabled: false,
    readonly: false,
    options: [],
    source: 'DOM',
  }));
  const inspection = ApplicationSchemaSchema.parse({
    inspectionId: 'inspection',
    applicationPlanId: 'plan',
    sourceUrl: url,
    finalUrl: url,
    redirectChain: [url],
    finalHostname: new URL(url).hostname,
    plannedApplicationType: 'EXTERNAL_ATS',
    platform: 'ASHBY',
    platformDiscrepancy: false,
    title: 'Fixture',
    fields,
    questions: [],
    documents: [
      {
        fieldId: 'resume',
        type: 'RESUME',
        label: 'Resume',
        required: true,
        acceptedFileTypes: ['application/pdf'],
        humanReviewRequired: false,
      },
    ],
    forms: [],
    ashbySubmission: {
      formDefinitionId: 'definition',
      actionId: 'submit-action',
      requiresCaptcha: false,
      surveyCount: 0,
      fields: fields.map((f) => ({
        path: f.id,
        title: f.label,
        type:
          f.type === 'TEXT' ? 'String' : f.type === 'EMAIL' ? 'Email' : 'File',
        required: true,
        fieldIds: [f.id],
        options: [],
      })),
    },
    authentication: { required: false },
    humanReview: { required: false, reasons: [] },
    confidence: 1,
    inspectionMetadata: {
      inspectedAt: at,
      durationMs: 1,
      visibleTextExcerpt: '',
      fieldCount: fields.length,
      formParserVersion: 3,
    },
  });
  const bytes = Buffer.from('%PDF-1.7\nfixture');
  return ExecutionInputSchema.parse({
    applicationId: 'application',
    executionId: 'execution',
    jobId: 'job',
    ownerId: 'owner',
    eligibilityState: 'RESOLVED',
    applicationPlanId: 'plan',
    inspectionId: 'inspection',
    preparationId: 'preparation',
    preparationVersion: 1,
    currentPreparationVersion: 1,
    preparationUpdatedAt: at,
    inspectionState: 'COMPLETED',
    preparationState: 'COMPLETED',
    plan,
    inspection,
    documents: [
      {
        id: 'document',
        type: 'RESUME',
        name: 'resume.pdf',
        storageRef: 'fixture',
        mimeType: 'application/pdf',
        size: bytes.length,
        metadata: { contentDigest: digest(bytes) },
      },
    ],
    preparedApplication: {
      version: 1,
      applicationId: 'application',
      inspectionId: 'inspection',
      jobId: 'job',
      overallStatus: 'COMPLETED',
      overallConfidence: 1,
      preparedAt: at,
      fields: [
        ['name', 'FULL_NAME', 'Ada'],
        ['email', 'EMAIL', 'ada@example.com'],
      ].map(([fieldId, semanticType, value]) => ({
        fieldId,
        semanticType,
        value,
        classificationSource: 'SCHEMA',
        source: 'PROFILE',
        confidence: 1,
        requiresHumanReview: false,
      })),
      questions: [],
      documents: [
        {
          requirementId: 'resume',
          documentId: 'document',
          documentType: 'RESUME',
          selectionReason: 'Fixture',
          confidence: 1,
          requiresHumanReview: false,
        },
      ],
      humanReviewItems: [],
    },
    mode: 'TEST_FIXTURE',
  });
}

export async function ashbyFixture() {
  const calls: {
    operation: string;
    body: Buffer;
    variables: Record<string, unknown>;
  }[] = [];
  const values: Record<string, unknown> = {};
  let origin = '',
    outcome = 'FormSubmitSuccess',
    captcha = false,
    drop = false,
    changed = false;
  const server = createServer(
    { key: testKey, cert: testCert },
    async (req, res) => {
      const url = new URL(req.url ?? '/', origin);
      if (req.method === 'GET') {
        res.setHeader('content-type', 'text/html');
        res.end(`<!doctype html><title>Fixture</title>
        <label for="name">Name</label><input id="name" required>
        <label for="email">Email</label><input id="email" type="email" required>
        <label for="resume">Resume</label><input id="resume" type="file" accept="application/pdf" required>
        <button type="submit">Submit Application</button>
        <script>fetch('/api/non-user-graphql?op=ApiJobPosting',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({operationName:'ApiJobPosting',query:'query ApiJobPosting($organizationHostedJobsPageName:String!,$jobPostingId:String!){jobPosting(organizationHostedJobsPageName:$organizationHostedJobsPageName,jobPostingId:$jobPostingId){id}}',variables:{organizationHostedJobsPageName:'fixture',jobPostingId:'posting'}})});</script>`);
        return;
      }
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(Buffer.from(chunk));
      const body = Buffer.concat(chunks);
      if (url.pathname === '/upload') {
        calls.push({ operation: 'Upload', body, variables: {} });
        res.writeHead(204);
        res.end();
        return;
      }
      const op = url.searchParams.get('op')!;
      const input = JSON.parse(body.toString());
      if (op !== 'ApiJobPosting')
        calls.push({ operation: op, body, variables: input.variables });
      res.setHeader('content-type', 'application/json');
      if (op === 'ApiJobPosting') {
        const posting = ashbyPosting(captcha);
        if (changed) posting.applicationForm.sourceFormDefinitionId = 'changed';
        res.end(JSON.stringify({ data: { jobPosting: posting } }));
      } else if (op === 'ApiSetFormValue') {
        values[input.variables.path] = input.variables.value;
        res.end(
          JSON.stringify({
            data: { setFormValue: { id: 'render', formErrors: [] } },
          }),
        );
      } else if (op === 'ApiCreateFileUploadHandle')
        res.end(
          JSON.stringify({
            data: {
              fileUploadHandle: {
                handle: 'file-capability',
                url: `${origin}/upload`,
                fields: { key: 'fixture-resume' },
              },
            },
          }),
        );
      else if (op === 'ApiSetFormValueToFile')
        res.end(
          JSON.stringify({
            data: { setFormValueToFile: { id: 'render', formErrors: [] } },
          }),
        );
      else if (op === 'ApiSubmitSingleApplicationFormAction') {
        if (drop) {
          req.socket.destroy();
          return;
        }
        res.end(
          JSON.stringify({
            data: {
              submitApplicationFormAction: {
                applicationFormResult: { __typename: outcome },
              },
            },
          }),
        );
      } else {
        res.writeHead(400);
        res.end('{}');
      }
    },
  );
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  if (!address || typeof address === 'string')
    throw new Error('Fixture bind failed');
  origin = `https://127.0.0.1:${address.port}`;
  const storage: DocumentStorage = {
    resolve: async () => ({
      name: 'resume.pdf',
      mimeType: 'application/pdf',
      buffer: Buffer.from('%PDF-1.7\nfixture'),
    }),
  };
  return {
    origin,
    input: ashbyInput(origin),
    calls,
    values,
    storage,
    setOutcome: (v: string) => {
      outcome = v;
    },
    setCaptcha: (v: boolean) => {
      captcha = v;
    },
    setDrop: () => {
      drop = true;
    },
    setChanged: () => {
      changed = true;
    },
    close: async () => {
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) =>
        server.close((e) => (e ? reject(e) : resolve())),
      );
    },
  };
}
