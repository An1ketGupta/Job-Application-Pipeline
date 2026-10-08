import Link from 'next/link';
import { GoogleFormSessionPanel } from '@/components/applications/GoogleFormWorkflow';
export default function Settings() {
  return (
    <section>
      <h1 className="text-2xl font-semibold">Local operation guide</h1>
      <p className="mt-3">
        CareerLift uses local email accounts, PostgreSQL, Redis, an API, and a
        workflow worker. Keep the API and worker running while preparing
        applications.
      </p>
      <h2 className="mt-6 font-bold">Execution modes</h2>
      <div className="mt-5">
        <GoogleFormSessionPanel />
      </div>
      <p className="mt-2">
        DRY_RUN checks a configured local fixture without submitting.
        TEST_FIXTURE can submit only to the explicitly configured test system.
        Google Forms uses its dedicated workflow when enabled locally: Apply
        starts it, required reviews pause it, and submission continues
        automatically after checks pass. Other real browser execution is
        disabled by default.
      </p>
      <h2 className="mt-6 font-bold">When manual action is needed</h2>
      <p className="mt-2">
        Review missing information in Human Review. CAPTCHA and authentication
        challenges stop automation. An unknown submission cannot be submitted
        again from this workspace; inspect the employer site and use
        verification to establish its outcome.
      </p>
      <p className="mt-6">
        For exact startup and acceptance-test commands, see the repository's
        docs/local-development.md.
      </p>
      <Link className="mt-5 inline-block text-indigo-700 underline" href="/">
        Return to Home
      </Link>
    </section>
  );
}
