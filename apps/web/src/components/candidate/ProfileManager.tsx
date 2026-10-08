'use client';
import { EmailTemplateEditor } from '../email/EmailSettings';
import React, { useEffect, useState } from 'react';
import Link from 'next/link';
import {
  ApplicationProfileSchema,
  type ApplicationProfile,
  type Evidence,
} from '@careerlift/domain';
import { request } from '@/lib/api';
import type { ProfileRecord } from '@/lib/candidate-types';
import {
  CandidateGate,
  useCandidateRead,
  Feedback,
  Field,
  panel,
  button,
  primary,
  input,
  message,
} from './CandidateUI';

type TextKey =
  | 'fullName'
  | 'firstName'
  | 'lastName'
  | 'preferredName'
  | 'email'
  | 'phone'
  | 'location'
  | 'city'
  | 'state'
  | 'country'
  | 'address'
  | 'headline'
  | 'summary'
  | 'linkedin'
  | 'github'
  | 'portfolio'
  | 'website';
const personal: [TextKey, string, string?][] = [
  ['fullName', 'Full name'],
  ['preferredName', 'Preferred name'],
  ['firstName', 'First name'],
  ['lastName', 'Last name'],
  ['email', 'Application email', 'email'],
  ['phone', 'Phone', 'tel'],
  ['location', 'Location'],
  ['city', 'City'],
  ['state', 'State / region'],
  ['country', 'Country'],
  ['address', 'Address'],
];
const links: [TextKey, string, string?][] = [
  ['linkedin', 'LinkedIn', 'url'],
  ['github', 'GitHub', 'url'],
  ['portfolio', 'Portfolio', 'url'],
  ['website', 'Personal website', 'url'],
];

function Entries({
  section,
  items,
  busy,
  update,
}: {
  section: 'experience' | 'education';
  items: Evidence[];
  busy: boolean;
  update: (items: Evidence[]) => Promise<boolean>;
}) {
  const [editing, setEditing] = useState<Evidence | null>(null);
  const education = section === 'education';
  const singular = education ? 'education' : 'experience';
  const fields: [keyof Evidence, string, string?][] = education
    ? [
        ['institution', 'Institution'],
        ['degree', 'Degree'],
        ['fieldOfStudy', 'Field of study'],
        ['startDate', 'Education start date', 'date'],
        ['endDate', 'Education end date', 'date'],
      ]
    : [
        ['company', 'Company'],
        ['title', 'Title'],
        ['location', 'Experience location'],
        ['startDate', 'Experience start date', 'date'],
        ['endDate', 'Experience end date', 'date'],
      ];
  return (
    <section
      className={panel}
      aria-label={education ? 'Education' : 'Experience'}
    >
      <div className="flex items-center justify-between gap-3">
        <h2 className="text-lg font-bold">
          {education ? 'Education' : 'Experience'}
        </h2>
        <button
          className={button}
          type="button"
          disabled={busy}
          onClick={() =>
            setEditing({
              id: crypto.randomUUID(),
              category: education ? 'EDUCATION' : 'EXPERIENCE',
              text: '',
              tags: [],
            })
          }
        >
          Add {singular}
        </button>
      </div>
      {!items.length && (
        <p className="mt-3 text-sm text-slate-500">No {singular} added yet.</p>
      )}
      <ul className="mt-3 space-y-3">
        {items.map((entry) => (
          <li key={entry.id} className="rounded-lg border border-slate-200 p-3">
            <p className="font-semibold">
              {education
                ? [entry.degree, entry.institution]
                    .filter(Boolean)
                    .join(' · ') || entry.text
                : [entry.title, entry.company].filter(Boolean).join(' · ') ||
                  entry.text}
            </p>
            <p className="mt-1 text-xs text-slate-500">
              {entry.startDate || 'Start date not specified'} —{' '}
              {entry.endDate || 'Present / not specified'}
            </p>
            {entry.description && (
              <p className="mt-2 whitespace-pre-wrap text-sm">
                {entry.description}
              </p>
            )}
            {entry.achievements?.length ? (
              <ul className="mt-2 list-disc pl-5 text-sm">
                {entry.achievements.map((a, i) => (
                  <li key={i}>{a}</li>
                ))}
              </ul>
            ) : null}
            <div className="mt-3 flex gap-2">
              <button
                className={button}
                type="button"
                disabled={busy}
                onClick={() => setEditing(entry)}
              >
                Edit {singular}
              </button>
              <button
                className={button}
                type="button"
                disabled={busy}
                onClick={() =>
                  void update(items.filter((e) => e.id !== entry.id))
                }
              >
                Remove {singular}
              </button>
            </div>
          </li>
        ))}
      </ul>
      {editing && (
        <form
          className="mt-5 space-y-3 border-t border-slate-200 pt-4"
          onSubmit={async (e) => {
            e.preventDefault();
            const parts = education
              ? [editing.degree, editing.fieldOfStudy, editing.institution]
              : [editing.title, editing.company, editing.location];
            const entry = {
              ...editing,
              text: [
                ...parts,
                editing.description,
                ...(editing.achievements ?? []),
              ]
                .filter(Boolean)
                .join('. '),
            };
            const next = items.some((i) => i.id === entry.id)
              ? items.map((i) => (i.id === entry.id ? entry : i))
              : [...items, entry];
            if (await update(next)) setEditing(null);
          }}
        >
          <h3 className="font-semibold">
            {items.some((i) => i.id === editing.id) ? 'Edit' : 'Add'} {singular}
          </h3>
          <div className="grid gap-3 sm:grid-cols-2">
            {fields.map(([key, label, type]) => (
              <Field key={key} label={label}>
                <input
                  className={input}
                  type={type ?? 'text'}
                  maxLength={300}
                  required={
                    education
                      ? key === 'institution' || key === 'degree'
                      : key === 'company' || key === 'title'
                  }
                  value={String(editing[key] ?? '')}
                  onChange={(e) =>
                    setEditing({ ...editing, [key]: e.target.value })
                  }
                />
              </Field>
            ))}
          </div>
          <Field
            label={
              education ? 'Education description' : 'Experience description'
            }
          >
            <textarea
              className={input}
              rows={3}
              maxLength={4000}
              value={editing.description ?? ''}
              onChange={(e) =>
                setEditing({ ...editing, description: e.target.value })
              }
            />
          </Field>
          {!education && (
            <Field label="Achievements (one per line)">
              <textarea
                className={input}
                rows={3}
                value={(editing.achievements ?? []).join('\n')}
                onChange={(e) =>
                  setEditing({
                    ...editing,
                    achievements: e.target.value.split('\n'),
                  })
                }
              />
            </Field>
          )}
          <p className="text-xs text-slate-500">
            Leave the end date blank for an ongoing role or course.
          </p>
          <div className="flex gap-2">
            <button className={primary} disabled={busy}>
              Save {singular}
            </button>
            <button
              className={button}
              type="button"
              onClick={() => setEditing(null)}
            >
              Cancel edit
            </button>
          </div>
        </form>
      )}
    </section>
  );
}
function ProfileEditor({ token }: { token: string }) {
  const query = useCandidateRead<ProfileRecord>('/api/v1/profile', token);
  const [record, setRecord] = useState<ProfileRecord | null>(null);
  const [draft, setDraft] = useState<ApplicationProfile>(
    ApplicationProfileSchema.parse({}),
  );
  const [skillsText, setSkillsText] = useState('');
  const [busy, setBusy] = useState(false),
    [error, setError] = useState<string | null>(null),
    [success, setSuccess] = useState<string | null>(null);
  useEffect(() => {
    if (query.data) {
      setRecord(query.data);
      setDraft(query.data.data);
      setSkillsText(query.data.data.skills.map((s) => s.text).join('\n'));
    }
  }, [query.data]);
  async function save(next = draft) {
    if (!record || busy) return false;
    const parsed = ApplicationProfileSchema.safeParse(next);
    setSuccess(null);
    if (!parsed.success) {
      setError(
        parsed.error.issues
          .map((i) => `${i.path.join('.')}: ${i.message}`)
          .join('; '),
      );
      return false;
    }
    setBusy(true);
    setError(null);
    try {
      const result = await request<ProfileRecord>(
        '/api/v1/profile',
        {
          method: 'PATCH',
          body: JSON.stringify({
            revision: record.revision,
            data: parsed.data,
          }),
        },
        token,
      );
      setRecord(result);
      setDraft(result.data);
      setSuccess(
        'Profile saved. Future preparation uses your updated information.',
      );
      return true;
    } catch (e) {
      setError(message(e));
      return false;
    } finally {
      setBusy(false);
    }
  }
  const renderFields = (fields: typeof personal) => (
    <div className="mt-4 grid gap-4 sm:grid-cols-2">
      {fields.map(([key, label, type]) => (
        <Field key={key} label={label}>
          <input
            className={input}
            type={type ?? 'text'}
            maxLength={type === 'url' ? 1000 : 300}
            value={draft[key] ?? ''}
            onChange={(e) => setDraft({ ...draft, [key]: e.target.value })}
          />
        </Field>
      ))}
    </div>
  );
  return (
    <article className="space-y-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold">Profile</h1>
          <p className="mt-1 text-sm text-slate-500">
            Your candidate information for future applications.
          </p>
        </div>
        <div className="flex gap-2">
          <Link className={button} href="/documents">
            Documents
          </Link>
          <Link className={button} href="/verified-answers">
            Verified answers
          </Link>
        </div>
      </div>
      <Feedback error={error || query.error} success={success} busy={busy} />
      {query.error && (
        <button className={button} onClick={query.refresh}>
          Reload profile
        </button>
      )}
      {!record ? (
        !query.error && <p role="status">Loading profile…</p>
      ) : (
        <>
          <form
            className="space-y-5"
            onSubmit={(e) => {
              e.preventDefault();
              void save();
            }}
          >
            <fieldset disabled={busy} className="space-y-5">
              <section className={panel}>
                <h2 className="text-lg font-bold">Personal information</h2>
                {renderFields(personal)}
                <p className="mt-3 text-xs text-slate-500">
                  Application email can differ from your account email.
                </p>
              </section>
              <section className={panel}>
                <h2 className="text-lg font-bold">Professional summary</h2>
                <div className="mt-4 space-y-4">
                  <Field label="Headline">
                    <input
                      className={input}
                      maxLength={300}
                      value={draft.headline ?? ''}
                      onChange={(e) =>
                        setDraft({ ...draft, headline: e.target.value })
                      }
                    />
                  </Field>
                  <Field label="Professional summary">
                    <textarea
                      className={input}
                      rows={5}
                      maxLength={5000}
                      value={draft.summary ?? ''}
                      onChange={(e) =>
                        setDraft({ ...draft, summary: e.target.value })
                      }
                    />
                  </Field>
                  <Field label="Years of experience">
                    <input
                      className={input}
                      type="number"
                      min={0}
                      max={80}
                      step={0.1}
                      value={draft.yearsOfExperience ?? ''}
                      onChange={(e) => {
                        const next = { ...draft };
                        if (e.target.value === '')
                          delete next.yearsOfExperience;
                        else next.yearsOfExperience = Number(e.target.value);
                        setDraft(next);
                      }}
                    />
                  </Field>
                </div>
              </section>
              <section className={panel}>
                <h2 className="text-lg font-bold">Skills</h2>
                <Field label="Skills (one per line)">
                  <textarea
                    className={input}
                    rows={4}
                    value={skillsText}
                    onChange={(e) => {
                      setSkillsText(e.target.value);
                      setDraft({
                        ...draft,
                        skills: e.target.value
                          .split('\n')
                          .filter((s) => s.trim())
                          .map(
                            (s) =>
                              draft.skills.find(
                                (entry) => entry.text === s.trim(),
                              ) ?? {
                                id: crypto.randomUUID(),
                                category: 'SKILL',
                                text: s.trim(),
                                tags: [],
                              },
                          ),
                      });
                    }}
                  />
                </Field>
              </section>
              <section className={panel}>
                <h2 className="text-lg font-bold">Links</h2>
                {renderFields(links)}
              </section>
            </fieldset>
            <div className="flex flex-wrap items-center gap-3">
              <button className={primary} disabled={busy}>
                Save profile
              </button>
              <button
                className={button}
                type="button"
                disabled={busy || query.busy}
                onClick={() => {
                  setError(null);
                  setSuccess(null);
                  query.refresh();
                }}
              >
                Reload saved profile
              </button>
              {record.updatedAt && (
                <p className="text-xs text-slate-500">
                  Last updated {new Date(record.updatedAt).toLocaleString()}
                </p>
              )}
            </div>
          </form>
          <Entries
            section="experience"
            items={draft.experience}
            busy={busy}
            update={(experience) => save({ ...draft, experience })}
          />
          <Entries
            section="education"
            items={draft.education}
            busy={busy}
            update={(education) => save({ ...draft, education })}
          />
          <section className={panel}>
            <h2 className="text-lg font-bold">Application information</h2>
            <p className="mt-3 text-sm text-slate-600">
              You control work authorization, sponsorship, compensation,
              relocation, and legal declarations through explicit verified
              answers. The agent will ask you when an answer is missing or
              ambiguous.
            </p>
            <Link href="/verified-answers" className={`${button} mt-4`}>
              Manage verified information
            </Link>
          </section>
        </>
      )}
    </article>
  );
}
export function ProfileManager() {
  return (
    <CandidateGate>
      {(token) => (
        <div className="space-y-5">
          <ProfileEditor token={token} />
          <EmailTemplateEditor token={token} />
        </div>
      )}
    </CandidateGate>
  );
}
