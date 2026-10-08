import { describe, expect, it } from 'vitest';
import { ApplicationPlanSchema } from '@careerlift/domain';
import { ApplicationInspector } from './inspector.js';
import { BrowserSessionManager } from './session.js';
import { DestinationPolicy } from './policy.js';

const url = 'https://jobs.ashbyhq.com/fixture/posting/application';
const plan = ApplicationPlanSchema.parse({
  jobId: 'job',
  applicationType: 'EXTERNAL_ATS',
  provider: 'ASHBY',
  destination: { url },
  requirements: [],
  actions: [],
  executor: 'BROWSER',
  confidence: 1,
  requiresHumanReview: false,
  reasoning: [],
  resolvedBy: 'deterministic',
});
class RenderSessions extends BrowserSessionManager {
  events = -1;
  constructor(private readonly html: string) {
    super(true, new DestinationPolicy(undefined, async () => ['8.8.8.8']));
  }
  override async create(guard?: (url: string) => void) {
    const session = await super.create(guard);
    await session.page.addInitScript(() => {
      Object.assign(window, { inspectionEvents: 0 });
      for (const type of ['click', 'input', 'change', 'submit'])
        document.addEventListener(
          type,
          () => {
            (window as unknown as { inspectionEvents: number })
              .inspectionEvents++;
          },
          true,
        );
    });
    await session.page.route(url, (route) =>
      route.fulfill({ contentType: 'text/html', body: this.html }),
    );
    return {
      ...session,
      close: async () => {
        this.events = await session.page.evaluate(
          () =>
            (window as unknown as { inspectionEvents: number })
              .inspectionEvents,
        );
        await session.close();
      },
    };
  }
}
describe('hosted form rendering', () => {
  it('waits for delayed, progressively rendered Ashby fields without filling or clicking', async () => {
    const sessions =
      new RenderSessions(`<title>Audiobook Specialists</title><main id="root"></main>
      <script>document.addEventListener('DOMContentLoaded', () => {
        setTimeout(() => { document.querySelector('#root').innerHTML = '<form><label>Name<input name="name" required></label></form>'; }, 450);
        setTimeout(() => { document.querySelector('form').insertAdjacentHTML('beforeend', '<label>Email<input name="email" type="email" required></label><label>Resume<input name="resume" type="file" required></label><button type="submit">Submit</button>'); }, 650);
      });</script>`);
    const result = await new ApplicationInspector(
      sessions,
      new Map(),
      2500,
    ).inspect(plan, 'plan', 'inspection');
    expect(result.status).toBe('COMPLETED');
    expect(result.schema?.fields.map((f) => f.name)).toEqual([
      'name',
      'email',
      'resume',
    ]);
    expect(result.schema?.documents[0]?.type).toBe('RESUME');
    expect(result.schema?.humanReview.reasons).toEqual([]);
    expect(sessions.events).toBe(0);
  }, 15000);
  it('bounds waiting for a permanently empty page and provides a retryable reason', async () => {
    const sessions = new RenderSessions(
      '<title>Application</title><div>Loading</div><input type="hidden" name="tracking">',
    );
    const result = await new ApplicationInspector(
      sessions,
      new Map(),
      400,
    ).inspect(plan, 'plan', 'inspection');
    expect(result).toMatchObject({
      status: 'HUMAN_REQUIRED',
      errorCode: 'FORM_FIELDS_NOT_FOUND',
    });
    expect(result.schema?.humanReview.reasons).toEqual([
      'INTERACTIVE_DISCOVERY_REQUIRED',
    ]);
    expect(result.schema?.fields).toEqual([]);
    expect(sessions.events).toBe(0);
  }, 15000);
  it.each([
    ['<title>Verify you are human</title><p>Captcha</p>', 'CAPTCHA'],
    ['<title>Sign in to apply</title>', 'AUTHENTICATION_REQUIRED'],
  ])(
    'preserves security review for %s',
    async (html, reason) => {
      const result = await new ApplicationInspector(
        new RenderSessions(html),
        new Map(),
        500,
      ).inspect(plan, 'plan', 'inspection');
      expect(result.status).toBe('HUMAN_REQUIRED');
      expect(result.schema?.humanReview.reasons).toContain(reason);
      expect(result.errorCode).toBeUndefined();
    },
    15000,
  );
});
