import type { Metadata } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: 'Clean Air Day-Planner for Schools',
  description:
    'When the air turns bad, every school gets a clear, bilingual action plan before the first bell, automatically.',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body className="min-h-screen bg-slate-50 text-slate-900 antialiased">{children}</body>
    </html>
  );
}
