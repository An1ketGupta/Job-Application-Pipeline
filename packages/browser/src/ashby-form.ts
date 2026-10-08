import { z } from 'zod';
import {
  AshbySubmissionSchema,
  type ApplicationField,
  type AshbySubmission,
} from '@careerlift/domain';

const providerField = z.object({
  path: z.string().min(1),
  title: z.string(),
  type: z.string(),
  selectableValues: z
    .array(z.object({ label: z.string(), value: z.string() }))
    .nullable()
    .optional(),
});
export const AshbyPostingSchema = z.object({
  id: z.string(),
  recaptchaAction: z.string().nullable().optional(),
  surveyForms: z.array(z.unknown()).optional(),
  applicationForm: z.object({
    id: z.string().min(1),
    sourceFormDefinitionId: z.string().min(1),
    formControls: z
      .array(z.object({ identifier: z.string().min(1), title: z.string() }))
      .min(1),
    sections: z.array(
      z.object({
        isHidden: z.boolean().nullable().optional(),
        fieldEntries: z.array(
          z.object({
            id: z.string(),
            isRequired: z.boolean(),
            isHidden: z.boolean().nullable().optional(),
            field: providerField,
          }),
        ),
      }),
    ),
  }),
});
export type AshbyPosting = z.infer<typeof AshbyPostingSchema>;
const normalized = (s: string) => s.trim().replace(/\s+/g, ' ');

export function captureAshbySubmission(
  raw: unknown,
  fields: ApplicationField[],
): AshbySubmission | undefined {
  const parsed = AshbyPostingSchema.safeParse(raw);
  if (!parsed.success) return;
  const p = parsed.data;
  if (p.applicationForm.formControls.length !== 1) return;
  const submission = AshbySubmissionSchema.safeParse({
    formDefinitionId: p.applicationForm.sourceFormDefinitionId,
    actionId: p.applicationForm.formControls[0]!.identifier,
    requiresCaptcha: Boolean(p.recaptchaAction),
    surveyCount: p.surveyForms?.length ?? 0,
    fields: p.applicationForm.sections
      .filter((s) => !s.isHidden)
      .flatMap((s) => s.fieldEntries)
      .filter((e) => !e.isHidden)
      .map((e) => ({
        path: e.field.path,
        title: normalized(e.field.title),
        type: e.field.type,
        required: e.isRequired,
        options: e.field.selectableValues ?? [],
        fieldIds: fields
          .filter(
            (f) =>
              f.domId === e.field.path ||
              f.domId === e.id ||
              f.name === e.id ||
              f.domId?.startsWith(`${e.id}-labeled-`) ||
              normalized(f.choiceGroup?.label ?? f.label).replace(
                /\s*\*$/,
                '',
              ) === normalized(e.field.title),
          )
          .map((f) => f.id),
      })),
  });
  return submission.success ? submission.data : undefined;
}

// Session/render IDs change on each visit. Definition, action, paths and options must match.
export function sameAshbyDefinition(a: AshbySubmission, b: AshbySubmission) {
  const identity = (v: AshbySubmission) =>
    JSON.stringify({
      ...v,
      fields: v.fields.map((f) => ({
        path: f.path,
        title: f.title,
        type: f.type,
        required: f.required,
        options: f.options,
      })),
    });
  return identity(a) === identity(b);
}

export const ASHBY_QUERIES = {
  setValue: `mutation ApiSetFormValue($organizationHostedJobsPageName:String!,$formRenderIdentifier:String!,$path:String!,$value:JSON,$formDefinitionIdentifier:String){setFormValue(organizationHostedJobsPageName:$organizationHostedJobsPageName,formRenderIdentifier:$formRenderIdentifier,path:$path,value:$value,formDefinitionIdentifier:$formDefinitionIdentifier){id formErrors{message fieldEntryId}}}`,
  uploadHandle: `mutation ApiCreateFileUploadHandle($organizationHostedJobsPageName:String!,$fileUploadContext:FileUploadContext!,$filename:String!,$contentType:String!,$contentLength:Int!){fileUploadHandle:createFileUploadHandle(organizationHostedJobsPageName:$organizationHostedJobsPageName,fileUploadContext:$fileUploadContext,filename:$filename,contentType:$contentType,contentLength:$contentLength){handle url fields}}`,
  setFile: `mutation ApiSetFormValueToFile($organizationHostedJobsPageName:String!,$formRenderIdentifier:String!,$path:String!,$fileHandle:String,$formDefinitionIdentifier:String){setFormValueToFile(organizationHostedJobsPageName:$organizationHostedJobsPageName,formRenderIdentifier:$formRenderIdentifier,path:$path,fileHandle:$fileHandle,formDefinitionIdentifier:$formDefinitionIdentifier){id formErrors{message fieldEntryId}}}`,
  submit: `mutation ApiSubmitSingleApplicationFormAction($organizationHostedJobsPageName:String!,$jobPostingId:String!,$formRenderIdentifier:String!,$formDefinitionIdentifier:String,$actionIdentifier:String!,$recaptchaToken:String!){submitApplicationFormAction:submitSingleApplicationFormAction(organizationHostedJobsPageName:$organizationHostedJobsPageName,jobPostingId:$jobPostingId,formRenderIdentifier:$formRenderIdentifier,formDefinitionIdentifier:$formDefinitionIdentifier,actionIdentifier:$actionIdentifier,recaptchaToken:$recaptchaToken){applicationFormResult{__typename ... on FormSubmitSuccess{_} ... on FormRender{id formErrors{message fieldEntryId}}}}}`,
} as const;
