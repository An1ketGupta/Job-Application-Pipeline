import './globals.css';
import type { Metadata } from 'next';
import { AuthProvider } from '@/lib/auth-context';
import { Navbar } from '@/components/Navbar';

export const metadata: Metadata = {
  title: 'CareerLift Agent',
  description: 'Job application planning and automated workflow agent',
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en">
      <body className="mx-auto max-w-4xl p-4 sm:p-8 text-slate-900 bg-slate-50/30 min-h-screen">
        <a
          href="#main-content"
          className="sr-only focus:not-sr-only focus:block focus:p-3"
        >
          Skip to content
        </a>
        <AuthProvider>
          <Navbar />
          <main id="main-content" tabIndex={-1}>
            {children}
          </main>
        </AuthProvider>
      </body>
    </html>
  );
}
