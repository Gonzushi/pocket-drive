import { dispatch } from '@/lib/api';
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
const handler = async (req: Request, context: { params: Promise<{ path: string[] }> }) => dispatch(req, (await context.params).path);
export { handler as GET, handler as POST, handler as DELETE, handler as HEAD, handler as PATCH };
