import { signedIn } from '@/lib/auth';
import { redirect } from 'next/navigation';
import Shell from '@/components/shell';
export const dynamic = 'force-dynamic';
export default async function DriveLayout({ children }: { children: React.ReactNode }) {
  if (!await signedIn()) redirect('/login');
  return <Shell>{children}</Shell>;
}
