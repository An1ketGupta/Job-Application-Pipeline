import { z } from 'zod';
import {
  ApplicationDestinationUrlSchema,
  atsUrlIdentity,
} from '@careerlift/domain';
import type {
  CareerLiftFixtureJob,
  CareerLiftJobSource,
} from './careerlift.js';

const OptionsSchema = z.object({
  query: z.string().trim().optional(),
  location: z.string().trim().optional(),
  type: z
    .enum(['Internship', 'Full-time', 'Full-time Internship', 'Apprenticeship'])
    .optional(),
  maxPages: z.number().int().min(1).max(20).default(1),
});

const ResponseSchema = z.object({
  jsonrpc: z.literal('2.0'),
  id: z.number(),
  error: z.object({ code: z.number(), message: z.string() }).optional(),
  result: z
    .object({
      isError: z.boolean().optional(),
      content: z.array(
        z.object({ type: z.string(), text: z.string().optional() }),
      ),
    })
    .optional(),
});

function parseSearch(text: string, page: number) {
  if (/^No (?:jobs|listings)\b/i.test(text.trim()))
    return { slugs: [], totalPages: 0 };
  const heading = /^(\d+) listings match; page (\d+) of (\d+)\./.exec(text);
  if (!heading || Number(heading[2]) !== page)
    throw new Error('Carrerlift MCP returned an unrecognized search response');
  const slugs = [...text.matchAll(/^\s{2}slug: ([a-z0-9-]+)\s*$/gm)].map(
    (match) => match[1]!,
  );
  if (Number(heading[1]) > 0 && slugs.length === 0)
    throw new Error(
      'Carrerlift MCP search response has no listing identifiers',
    );
  return { slugs, totalPages: Number(heading[3]) };
}

function parseJob(text: string, slug: string): CareerLiftFixtureJob {
  // Parse only the provider's labelled metadata, never links or commands inside
  // the untrusted description. Carrerlift currently exposes text content only.
  const separator = text.indexOf('\nDescription:\n');
  if (separator < 0)
    throw new Error('Carrerlift MCP returned an unrecognized job response');
  const metadata = text.slice(0, separator);
  const lines = metadata.split('\n');
  const title = /^(.*?) at (.+)$/.exec(lines[0] ?? '');
  if (!title?.[1] || !title[2])
    throw new Error('Carrerlift MCP job is missing its title or company');
  const field = (label: string) =>
    lines
      .find((line) => line.startsWith(`${label}: `))
      ?.slice(label.length + 2)
      .trim();
  const sourceUrl = field('Page');
  const parsedUrl = z.string().url().safeParse(sourceUrl);
  if (!parsedUrl.success)
    throw new Error('Carrerlift MCP job is missing its source link');
  const pageUrl = new URL(parsedUrl.data);
  if (
    pageUrl.protocol !== 'https:' ||
    !['carrerlift.in', 'www.carrerlift.in'].includes(pageUrl.hostname) ||
    pageUrl.username ||
    pageUrl.password ||
    pageUrl.pathname !== `/jobs/${slug}`
  )
    throw new Error(
      'Carrerlift MCP job source link does not match its identifier',
    );

  const applyLink = field('Apply link');
  const email = field('Email') ?? field('HR email');
  const whatsapp = field('WhatsApp');
  const destination = ApplicationDestinationUrlSchema.safeParse(applyLink);
  const validEmail = z.string().email().safeParse(email);
  const application: NonNullable<CareerLiftFixtureJob['application']> = {
    ...(destination.success ? { url: destination.data } : {}),
    ...(validEmail.success ? { email: validEmail.data } : {}),
  };
  if (destination.success) {
    const ats = atsUrlIdentity(destination.data);
    const url = new URL(destination.data);
    if (ats) {
      application.type = 'ats';
      application.provider = ats.platform.toLowerCase();
    } else if (
      url.hostname === 'docs.google.com' &&
      url.pathname.startsWith('/forms/')
    ) {
      application.type = 'google_form';
    } else if (
      url.hostname === 'docs.google.com' &&
      url.pathname.startsWith('/document/')
    ) {
      application.type = 'google_doc';
    } else if (
      (url.hostname === 'linkedin.com' ||
        url.hostname.endsWith('.linkedin.com')) &&
      url.pathname.startsWith('/jobs/')
    ) {
      application.type = 'linkedin';
    } else {
      application.type = 'direct';
    }
  } else if (validEmail.success) {
    application.type = 'email';
  }
  if (
    (!destination.success && !validEmail.success) ||
    (applyLink && !destination.success) ||
    (email && !validEmail.success) ||
    whatsapp
  ) {
    application.type = 'human_required';
    application.requiresHumanReview = true;
  }

  const posted = field('Posted');
  const postedAt =
    posted && /^\d{4}-\d{2}-\d{2}$/.test(posted)
      ? `${posted}T00:00:00.000Z`
      : undefined;
  const location = field('Location');
  const employmentType = field('Type');
  const pay = field('Pay');
  return {
    id: slug,
    role: title[1],
    company: title[2],
    ...(location ? { location } : {}),
    ...(employmentType ? { employmentType } : {}),
    description: [
      ...(pay ? [`Pay: ${pay}`] : []),
      ...(whatsapp ? [`WhatsApp: ${whatsapp}`] : []),
      ...(!destination.success && applyLink
        ? [`Apply link: ${applyLink}`]
        : []),
      ...(!validEmail.success && email ? [`HR email: ${email}`] : []),
      text.slice(separator + '\nDescription:\n'.length),
    ].join('\n\n'),
    sourceUrl: parsedUrl.data,
    ...(postedAt ? { postedAt } : {}),
    application,
  };
}

// This integration targets Carrerlift's documented stateless JSON transport,
// not arbitrary MCP servers. No sessions, SSE stream or credentials are needed.
export class CareerLiftMcpJobSource implements CareerLiftJobSource {
  readonly applicationSource = 'careerlift-mcp';
  private readonly options: z.infer<typeof OptionsSchema>;

  constructor(
    private readonly mcpUrl: string,
    options: z.input<typeof OptionsSchema> = {},
  ) {
    z.string().url().parse(mcpUrl);
    this.options = OptionsSchema.parse(options);
  }

  async fetchJobs(): Promise<CareerLiftFixtureJob[]> {
    const controller = new AbortController();
    const signal = AbortSignal.any([
      controller.signal,
      AbortSignal.timeout(90000),
    ]);
    let requestId = 0;
    const call = async (name: string, args: Record<string, unknown>) => {
      const id = ++requestId;
      const response = await fetch(this.mcpUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json, text/event-stream',
        },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id,
          method: 'tools/call',
          params: { name, arguments: args },
        }),
        signal: AbortSignal.any([signal, AbortSignal.timeout(15000)]),
      });
      if (!response.ok)
        throw new Error(`Carrerlift MCP returned HTTP ${response.status}`);
      const data = ResponseSchema.parse(await response.json());
      if (data.id !== id || data.error || !data.result || data.result.isError)
        throw new Error('Carrerlift MCP tool call failed');
      const text = data.result.content
        .filter((item) => item.type === 'text')
        .map((item) => item.text ?? '')
        .join('\n');
      if (!text.trim())
        throw new Error('Carrerlift MCP returned empty content');
      return text.replaceAll('\r\n', '\n');
    };

    try {
      const slugs = new Set<string>();
      const { maxPages, ...filters } = this.options;
      for (let page = 1; page <= maxPages; page++) {
        const result = parseSearch(
          await call('search_jobs', { ...filters, page }),
          page,
        );
        for (const slug of result.slugs) slugs.add(slug);
        if (page >= result.totalPages) break;
      }
      const pending = [...slugs];
      const jobs: CareerLiftFixtureJob[] = new Array(pending.length);
      let next = 0;
      // Keep detail requests bounded while obtaining actual employer apply
      // destinations; the search links point to Carrerlift, not application forms.
      await Promise.all(
        Array.from({ length: Math.min(4, pending.length) }, async () => {
          while (next < pending.length) {
            signal.throwIfAborted();
            const index = next++;
            const slug = pending[index]!;
            jobs[index] = parseJob(await call('get_job', { slug }), slug);
          }
        }),
      );
      return jobs;
    } catch (error) {
      controller.abort();
      throw error;
    }
  }
}
