import { signedIn } from '@/lib/server/auth';
import { redirect } from 'next/navigation';
import Login from '@/components/ui/login';
export const dynamic = 'force-dynamic';
export default async function LoginPage() {
  if (await signedIn()) redirect('/files');
  return <Login />;
}
