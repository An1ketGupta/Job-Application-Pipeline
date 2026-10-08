import Link from 'next/link';
export default function NotFound() {
  return (
    <section className="space-y-4">
      <h1 className="text-2xl font-bold">Page not found</h1>
      <p>
        This page is unavailable. Use the navigation to return to your
        workspace.
      </p>
      <Link className="inline-block text-indigo-700 underline" href="/">
        Return to Home
      </Link>
    </section>
  );
}
