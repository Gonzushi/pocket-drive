import { signedIn } from '@/lib/server/auth';
import { redirect } from 'next/navigation';
import Shell from '@/components/ui/shell';
export const dynamic = 'force-dynamic';
export default async function DriveLayout({ children }: { children: React.ReactNode }) {
  if (!(await signedIn())) redirect('/login');
  return <Shell>{children}</Shell>;
}
