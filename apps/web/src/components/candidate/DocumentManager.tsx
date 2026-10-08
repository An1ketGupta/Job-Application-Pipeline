'use client';
import React, { useState } from 'react';
import Link from 'next/link';
import { DocumentTypeSchema } from '@careerlift/domain';
import { request, downloadDocument } from '@/lib/api';
import type { CandidateDocument } from '@/lib/candidate-types';
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

function DocumentEditor({ token }: { token: string }) {
  const query = useCandidateRead<{ documents: CandidateDocument[] }>(
    '/api/v1/documents',
    token,
  );
  const [type, setType] = useState('RESUME'),
    [file, setFile] = useState<File | null>(null);
  const [jobTitles, setJobTitles] = useState('');
  const [editingTitles, setEditingTitles] = useState<string | null>(null),
    [titleText, setTitleText] = useState('');
  const [busy, setBusy] = useState(false),
    [error, setError] = useState<string | null>(null),
    [success, setSuccess] = useState<string | null>(null);
  const [renaming, setRenaming] = useState<string | null>(null),
    [name, setName] = useState(''),
    [showArchived, setShowArchived] = useState(false);
  async function act(action: () => Promise<unknown>, feedback: string) {
    if (busy) return;
    setBusy(true);
    setError(null);
    setSuccess(null);
    try {
      await action();
      setSuccess(feedback);
      query.refresh();
      setRenaming(null);
      setEditingTitles(null);
    } catch (e) {
      setError(message(e));
    } finally {
      setBusy(false);
    }
  }
  const update = (
    doc: CandidateDocument,
    changes: Record<string, unknown>,
    feedback: string,
  ) =>
    act(
      () =>
        request(
          `/api/v1/documents/${encodeURIComponent(doc.id)}`,
          {
            method: 'PATCH',
            body: JSON.stringify({ revision: doc.revision, ...changes }),
          },
          token,
        ),
      feedback,
    );
  async function upload(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = e.currentTarget;
    if (!file) {
      setError('Choose a PDF or TXT document.');
      return;
    }
    if (
      !file.size ||
      file.size > 10 * 1024 * 1024 ||
      !/\.(pdf|txt)$/i.test(file.name)
    ) {
      setError('Choose a nonempty PDF or TXT document up to 10 MB.');
      return;
    }
    await act(async () => {
      const content = await new Promise<string>((resolve, reject) => {
        const reader = new FileReader();
        reader.onerror = () => reject(new Error('Unable to read this file.'));
        reader.onload = () =>
          resolve(String(reader.result).split(',')[1] ?? '');
        reader.readAsDataURL(file);
      });
      await request(
        '/api/v1/documents',
        {
          method: 'POST',
          body: JSON.stringify({
            name: file.name,
            type,
            content,
            jobTitles:
              type === 'RESUME'
                ? jobTitles
                    .split(',')
                    .map((v) => v.trim())
                    .filter(Boolean)
                : [],
          }),
        },
        token,
      );
      setFile(null);
      setJobTitles('');
      form.reset();
    }, 'Document uploaded. Choose “Use by default” when appropriate.');
  }
  return (
    <article className="space-y-5">
      <div className="flex flex-wrap justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold">Documents</h1>
          <p className="mt-1 text-sm text-slate-500">
            Manage resumes, cover letters, and supporting documents.
          </p>
        </div>
        <Link className={button} href="/profile">
          Back to Profile
        </Link>
      </div>
      <Feedback error={error || query.error} success={success} busy={busy} />
      <form className={`${panel} space-y-4`} onSubmit={upload}>
        <h2 className="font-bold">Upload a document</h2>
        <fieldset className="grid gap-4 sm:grid-cols-2" disabled={busy}>
          <Field label="Document type">
            <select
              className={input}
              value={type}
              onChange={(e) => setType(e.target.value)}
            >
              {DocumentTypeSchema.options.map((option) => (
                <option key={option} value={option}>
                  {option.replaceAll('_', ' ')}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Document file">
            <input
              className={input}
              type="file"
              accept=".pdf,.txt,application/pdf,text/plain"
              required
              onChange={(e) => setFile(e.target.files?.[0] ?? null)}
            />
          </Field>
        </fieldset>
        {type === 'RESUME' && (
          <Field label="Target job titles (separate with commas)">
            <input
              className={input}
              value={jobTitles}
              disabled={busy}
              onChange={(e) => setJobTitles(e.target.value)}
              placeholder="AI Engineer, Machine Learning Intern"
            />
          </Field>
        )}
        <p className="text-xs text-slate-500">
          PDF or UTF-8 TXT, up to 10 MB. Upload a new file to replace document
          content.
        </p>
        <button className={primary} disabled={busy}>
          Upload document
        </button>
      </form>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <label className="flex gap-2 text-sm">
          <input
            type="checkbox"
            checked={showArchived}
            onChange={(e) => setShowArchived(e.target.checked)}
          />
          Show archived documents
        </label>
        <button
          className={button}
          disabled={busy || query.busy}
          onClick={query.refresh}
        >
          Refresh documents
        </button>
      </div>
      {!query.data && !query.error && <p role="status">Loading documents…</p>}
      {query.data &&
        !query.data.documents.filter((d) => showArchived || !d.archivedAt)
          .length && (
          <section className={panel}>
            <p>No documents yet. Upload a resume to get started.</p>
          </section>
        )}
      <div className="grid gap-4 md:grid-cols-2">
        {query.data?.documents
          .filter((d) => showArchived || !d.archivedAt)
          .map((doc) => (
            <section key={doc.id} className={panel} aria-label={doc.name}>
              <h2 className="break-all font-bold">{doc.name}</h2>
              <p className="mt-2 text-sm">
                {doc.type.replaceAll('_', ' ')} ·{' '}
                {doc.archivedAt
                  ? 'Archived'
                  : doc.isDefault
                    ? 'Active · Default'
                    : 'Active'}
              </p>
              <dl className="mt-3 text-xs text-slate-500">
                <dt>File</dt>
                <dd>
                  {doc.mimeType} · {(doc.size / 1024).toFixed(1)} KB
                </dd>
                <dt className="mt-2">Uploaded</dt>
                <dd>{new Date(doc.createdAt).toLocaleString()}</dd>
                <dt className="mt-2">Updated</dt>
                <dd>{new Date(doc.updatedAt).toLocaleString()}</dd>
              </dl>
              {doc.type === 'RESUME' && !doc.archivedAt && (
                <div className="mt-3 text-sm">
                  <p>
                    Target job titles: {doc.jobTitles?.join(', ') || 'Not set'}
                  </p>
                  {editingTitles === doc.id ? (
                    <form
                      className="mt-2 space-y-2"
                      onSubmit={(e) => {
                        e.preventDefault();
                        void update(
                          doc,
                          {
                            jobTitles: titleText
                              .split(',')
                              .map((v) => v.trim())
                              .filter(Boolean),
                          },
                          'Resume target titles saved.',
                        );
                      }}
                    >
                      <Field label="Target job titles">
                        <input
                          className={input}
                          value={titleText}
                          onChange={(e) => setTitleText(e.target.value)}
                          placeholder="Backend Engineer, Software Engineer"
                        />
                      </Field>
                      <button className={button} disabled={busy}>
                        Save target titles
                      </button>
                      <button
                        type="button"
                        className={`${button} ml-2`}
                        onClick={() => setEditingTitles(null)}
                      >
                        Cancel
                      </button>
                    </form>
                  ) : (
                    <button
                      className={`${button} mt-2`}
                      disabled={busy}
                      onClick={() => {
                        setEditingTitles(doc.id);
                        setTitleText(doc.jobTitles?.join(', ') ?? '');
                      }}
                    >
                      Edit target titles
                    </button>
                  )}
                </div>
              )}
              {renaming === doc.id ? (
                <form
                  className="mt-4 space-y-3"
                  onSubmit={(e) => {
                    e.preventDefault();
                    void update(doc, { name }, 'Document renamed.');
                  }}
                >
                  <Field label="Document name">
                    <input
                      className={input}
                      required
                      maxLength={154}
                      value={name}
                      onChange={(e) => setName(e.target.value)}
                    />
                  </Field>
                  <div className="flex gap-2">
                    <button className={primary} disabled={busy}>
                      Save name
                    </button>
                    <button
                      type="button"
                      className={button}
                      onClick={() => setRenaming(null)}
                    >
                      Cancel rename
                    </button>
                  </div>
                </form>
              ) : (
                <div className="mt-4 flex flex-wrap gap-2">
                  {doc.archivedAt ? (
                    <button
                      className={button}
                      disabled={busy}
                      onClick={() =>
                        void update(
                          doc,
                          { archived: false },
                          'Document restored.',
                        )
                      }
                    >
                      Restore
                    </button>
                  ) : (
                    <>
                      <button
                        className={button}
                        disabled={busy || doc.isDefault}
                        onClick={() =>
                          void update(
                            doc,
                            { isDefault: true },
                            'Default document saved for future preparation.',
                          )
                        }
                      >
                        {doc.isDefault ? 'Default document' : 'Use by default'}
                      </button>
                      {doc.isDefault && (
                        <button
                          className={button}
                          disabled={busy}
                          onClick={() =>
                            void update(
                              doc,
                              { isDefault: false },
                              'Default selection removed.',
                            )
                          }
                        >
                          Clear default
                        </button>
                      )}
                      <button
                        className={button}
                        disabled={busy}
                        onClick={() => {
                          setName(doc.name);
                          setRenaming(doc.id);
                        }}
                      >
                        Rename
                      </button>
                      <button
                        className={button}
                        disabled={busy}
                        onClick={() =>
                          void act(async () => {
                            const blob = await downloadDocument(doc.id, token);
                            const url = URL.createObjectURL(blob);
                            const link = document.createElement('a');
                            link.href = url;
                            link.download = doc.name;
                            link.click();
                            setTimeout(() => URL.revokeObjectURL(url), 1000);
                          }, 'Document downloaded.')
                        }
                      >
                        Download
                      </button>
                      <button
                        className={button}
                        disabled={busy}
                        onClick={() =>
                          void act(
                            () =>
                              request(
                                `/api/v1/documents/${encodeURIComponent(doc.id)}`,
                                {
                                  method: 'DELETE',
                                  body: JSON.stringify({
                                    revision: doc.revision,
                                  }),
                                },
                                token,
                              ),
                            'Document archived. Historical application references are retained.',
                          )
                        }
                      >
                        Archive
                      </button>
                    </>
                  )}
                </div>
              )}
            </section>
          ))}
      </div>
      <p className="text-xs text-slate-500">
        Default selections are preferences. The preparation engine validates the
        document against each application. Archiving removes a document from
        future use and preserves historical records.
      </p>
    </article>
  );
}
export function DocumentManager() {
  return (
    <CandidateGate>{(token) => <DocumentEditor token={token} />}</CandidateGate>
  );
}
