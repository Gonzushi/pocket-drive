import Keys from '@/components/ui/keys';
import { signedIn } from '@/lib/server/auth';
import { config } from '@/lib/server/config';
import { listApiKeys } from '@/lib/server/keys';
import { redirect } from 'next/navigation';

export default async function KeysPage() {
  // Pages can render concurrently with layouts; check before reading private data.
  if (!(await signedIn())) redirect('/login');
  return <Keys initialKeys={listApiKeys()} origin={config().origin} />;
}
