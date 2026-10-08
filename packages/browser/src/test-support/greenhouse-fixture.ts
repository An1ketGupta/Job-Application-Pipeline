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

export const greenhouseSource =
  'https://job-boards.greenhouse.io/fixture/jobs/123';
export function greenhousePosting() {
  return {
    jobPostId: '123',
    urlToken: 'fixture',
    submitPath: 'https://boards.greenhouse.io/fixture/jobs/123',
    confirmationPath: '/fixture/jobs/123/confirmation',
    jobPost: {
      fingerprint: 'fixture-fingerprint',
      education_config: {},
      employment: 'hidden',
      questions: [
        {
          label: 'First Name',
          required: true,
          fields: [{ name: 'first_name', type: 'input_text' }],
        },
        {
          label: 'Email',
          required: true,
          fields: [{ name: 'email', type: 'input_text' }],
        },
        {
          label: 'Resume/CV',
          required: true,
          fields: [
            { name: 'resume', type: 'input_file', allowed_filetypes: ['pdf'] },
            { name: 'resume_text', type: 'textarea' },
          ],
        },
        {
          label: 'Are you available for the internship?',
          required: true,
          fields: [
            {
              name: 'question_1',
              type: 'multi_value_single_select',
              values: [
                { label: 'Yes', value: 1 },
                { label: 'No', value: 0 },
              ],
            },
          ],
        },
      ],
    },
  };
}
export function greenhouseHtml(
  origin: string,
  changed = false,
  malicious = false,
) {
  const posting = greenhousePosting();
  if (changed)
    posting.jobPost.questions[3]!.label =
      'Are you available for a different internship?';
  return `<!doctype html><html><head><meta charset="utf-8"><title>Greenhouse fixture</title></head><body>
  <form id="application-form"><label for="first_name">First Name*</label><input id="first_name" aria-required="true">
  <label for="email">Email*</label><input id="email" aria-required="true">
  <label for="country">Country</label><input id="country" role="combobox">
  <div role="group" aria-labelledby="resume-label" aria-required="true"><span id="resume-label">Resume/CV*</span><label for="resume">Attach</label><input id="resume" type="file" accept=".pdf"></div>
  <label for="question_1">Are you available for the internship?*</label><input id="question_1" role="combobox" aria-required="true" readonly>
  <input required aria-hidden="true"><button type="button" id="submit">Submit application</button></form>
  <script>window.__remixContext = ${JSON.stringify({ state: { loaderData: { posting } } })};</script>
  <script>
  const q=document.getElementById('question_1');let choice=null,uploaded=null;
  const country=document.getElementById('country');country.addEventListener('input',()=>{
    document.getElementById('country-options')?.remove();const list=document.createElement('div');list.id='country-options';
    for(const label of ['British Indian Ocean Territory +246','India +91']){const option=document.createElement('div');option.setAttribute('role','option');option.textContent=label;option.onclick=()=>{country.value=label;list.remove()};list.append(option)}document.body.append(list);
  });
  q.addEventListener('click',()=>{const list=document.createElement('div');list.setAttribute('role','listbox');
   for(const [label,value] of [['Yes','1'],['No','0']]){const option=document.createElement('div');option.setAttribute('role','option');option.textContent=label;
    option.onclick=()=>{q.value=label;choice=value;list.remove()};list.append(option)}document.body.append(list)});
  let handle;const metadata=fetch('/fixture/jobs/123/uncacheable_attributes/presigned_fields?fields%5B%5D=resume').then(r=>r.json()).then(j=>{handle=j});
  document.getElementById('resume').onchange=async e=>{await metadata;const fd=new FormData();fd.append('utf8','✓');for(const [k,v] of Object.entries(handle.resume.fields))fd.append(k,v);
    fd.append('key',handle.resume.key.replace('{timestamp}',Date.now()).replace('{unique_id}','fixture'));fd.append('authenticity_token','1234');fd.append('Content-Type','application/octet-stream');fd.append('file',e.target.files[0]);
    const r=await fetch(handle.url,{method:'POST',body:fd});if(r.ok)uploaded={name:e.target.files[0].name,url:handle.url+'/'+fd.get('key')};};
  document.getElementById('submit').onclick=async()=>{
    const app={first_name:document.getElementById('first_name').value,last_name:'',email:document.getElementById('email').value,
      answers_attributes:{'1':{question_id:'1',priority:0,boolean_value:Number(choice)}},demographic_answers:[],data_compliance:{},attachments:{},from_job_board_renderer:true,employments:[],
      mapped_url_token:null,appcast_click_id:null,time_zone:Intl.DateTimeFormat().resolvedOptions().timeZone,
      resume_url:uploaded?.url,resume_url_filename:uploaded?.name};
    if(${malicious})app.email='attacker@example.com';
    const response=await fetch('/fixture/jobs/123/submit',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({job_application:app,fingerprint:'fixture-fingerprint','g-recaptcha-enterprise-token':'human-verification-token'})});
    document.body.dataset.captured=String(response.status===409);
  };
  </script></body></html>`;
}

export function greenhouseInput(origin: string): ExecutionInput {
  const url = `${origin}/fixture/jobs/123`,
    at = new Date().toISOString();
  const plan = ApplicationPlanSchema.parse({
    jobId: 'job',
    applicationType: 'EXTERNAL_ATS',
    provider: 'GREENHOUSE',
    destination: {
      url,
      target: {
        platform: 'GREENHOUSE',
        adapterVersion: 1,
        canonicalUrl: url,
        boardToken: 'fixture',
        externalJobId: '123',
        company: 'Fixture',
        role: 'Intern',
        metadataSource: 'JOB_UNTRUSTED',
        entryPoint: { url, kind: 'HOSTED_FORM' },
        fixtureSourceUrl: greenhouseSource,
        capabilities: {
          supportsFileUpload: true,
          supportsResumeUpload: true,
          supportsCoverLetter: true,
          supportsDynamicQuestions: true,
          supportsMultiStepForms: true,
          supportsKnownSuccessSignals: false,
        },
        inspectionHints: { formIsDynamic: true, navigation: 'HOSTED_FORM' },
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
  const fields = [
    ['first_name', 'First Name', 'TEXT'],
    ['email', 'Email', 'EMAIL'],
    ['resume', 'Resume/CV', 'FILE'],
    ['question_1', 'Are you available for the internship?', 'SELECT'],
  ].map(([id, label, type]) => ({
    id,
    domId: id,
    label,
    type,
    required: true,
    visible: true,
    disabled: false,
    readonly: false,
    options: type === 'SELECT' ? ['Yes', 'No'] : [],
    ...(type === 'SELECT'
      ? {
          selectOptions: [
            { label: 'Yes', value: '1', disabled: false },
            { label: 'No', value: '0', disabled: false },
          ],
        }
      : {}),
    htmlType: type === 'FILE' ? 'file' : 'text',
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
    platform: 'GREENHOUSE',
    platformDiscrepancy: false,
    title: 'Greenhouse fixture',
    fields: [
      ...fields,
      {
        id: 'country',
        domId: 'country',
        label: 'Phone country',
        type: 'TEXT',
        semanticType: 'COUNTRY',
        required: false,
        visible: true,
        disabled: false,
        readonly: false,
        options: [],
        source: 'DOM',
      },
    ],
    forms: [],
    questions: [
      {
        id: 'q1',
        text: 'Are you available for the internship?',
        fieldId: 'question_1',
        type: 'SELECT',
        required: true,
        sensitivity: 'NONE',
        semanticType: 'CUSTOM_QUESTION',
        answerSource: 'UNRESOLVED',
        humanReviewRequired: false,
      },
    ],
    documents: [
      {
        fieldId: 'resume',
        type: 'RESUME',
        label: 'Resume/CV',
        required: true,
        acceptedFileTypes: ['.pdf'],
        humanReviewRequired: false,
      },
    ],
    greenhouseSubmission: {
      boardToken: 'fixture',
      jobId: '123',
      submitUrl: 'https://boards.greenhouse.io/fixture/jobs/123',
      confirmationUrl: `${greenhouseSource}/confirmation`,
      requiresBrowserAssistance: true,
      unsupportedFeatures: [],
      fields: fields.map((f) => ({
        fieldId: f.id,
        name: f.domId,
        label: f.label,
        type:
          f.type === 'FILE' ? 'FILE' : f.type === 'SELECT' ? 'SELECT' : 'TEXT',
        required: true,
        options:
          f.type === 'SELECT'
            ? [
                { label: 'Yes', value: '1' },
                { label: 'No', value: '0' },
              ]
            : [],
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
      formParserVersion: 5,
    },
  });
  const bytes = Buffer.from('%PDF-1.7\nfixture');
  return ExecutionInputSchema.parse({
    applicationId: 'application',
    executionId: 'execution',
    mode: 'TEST_FIXTURE',
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
        ['first_name', 'FIRST_NAME', 'Ada'],
        ['email', 'EMAIL', 'ada@example.com'],
        ['country', 'COUNTRY', 'India'],
      ].map(([fieldId, semanticType, value]) => ({
        fieldId,
        semanticType,
        value,
        classificationSource: 'SCHEMA',
        source: 'PROFILE',
        confidence: 1,
        requiresHumanReview: false,
      })),
      questions: [
        {
          questionId: 'q1',
          category: 'CUSTOM_QUESTION',
          answer: 'Yes',
          source: 'USER_VERIFIED',
          confidence: 1,
          evidenceIds: [],
          requiresHumanReview: false,
        },
      ],
      documents: [
        {
          requirementId: 'resume',
          documentId: 'document',
          documentType: 'RESUME',
          selectionReason: 'Selected document',
          confidence: 1,
          requiresHumanReview: false,
        },
      ],
      humanReviewItems: [],
    },
  });
}

export async function greenhouseFixture(
  options: {
    changed?: boolean;
    malicious?: boolean;
    drop?: boolean;
    reject?: boolean;
  } = {},
) {
  const calls: { path: string; body: Buffer }[] = [];
  let origin = '';
  const server = createServer(
    { key: testKey, cert: testCert },
    async (req, res) => {
      const u = new URL(req.url!, origin),
        chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(Buffer.from(chunk));
      if (req.method === 'POST') {
        calls.push({ path: u.pathname, body: Buffer.concat(chunks) });
        if (u.pathname.endsWith('/submit')) {
          if (options.drop) {
            req.socket.destroy();
            return;
          }
          res.writeHead(options.reject ? 422 : 200, {
            'content-type': 'application/json',
          });
          res.end(
            JSON.stringify(
              options.reject
                ? { code: 'invalid-application' }
                : { success: true },
            ),
          );
        } else {
          res.writeHead(201, { 'content-type': 'application/xml' });
          res.end('<PostResponse/>');
        }
        return;
      }
      if (u.pathname.endsWith('/presigned_fields')) {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(
          JSON.stringify({
            url: `${origin}/upload`,
            resume: {
              key: 'stash/applications/resumes/{timestamp}-{unique_id}-fixture',
              fields: { policy: 'fixture-policy' },
            },
          }),
        );
        return;
      }
      res.writeHead(200, { 'content-type': 'text/html' });
      res.end(greenhouseHtml(origin, options.changed, options.malicious));
    },
  );
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const addr = server.address() as { port: number };
  origin = `https://127.0.0.1:${addr.port}`;
  const storage: DocumentStorage = {
    resolve: async () => ({
      name: 'resume.pdf',
      mimeType: 'application/pdf',
      buffer: Buffer.from('%PDF-1.7\nfixture'),
    }),
  };
  return {
    origin,
    calls,
    input: greenhouseInput(origin),
    storage,
    close: async () => {
      server.closeAllConnections();
      server.close();
      await once(server, 'close');
    },
  };
}
