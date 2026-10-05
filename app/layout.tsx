import type { Metadata } from 'next';
import './globals.css';
export const metadata: Metadata = { title: 'Pocket Drive · Your private files', description: 'A simple, private home for your files.', robots: { index: false, follow: false } };
export default function RootLayout({ children }: { children: React.ReactNode }) {
  return <html lang="en"><body>{children}</body></html>;
}
