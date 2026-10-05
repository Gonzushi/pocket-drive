export function formatBytes(bytes: number, decimals = 1) {
  if (!bytes) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const index = Math.min(Math.floor(Math.log(bytes) / Math.log(1000)), 4);
  return `${(bytes / 1000 ** index).toFixed(index === 0 ? 0 : decimals)} ${units[index]}`;
}
export function formatDate(date: string) { return new Intl.DateTimeFormat('en', { month: 'short', day: 'numeric', year: 'numeric' }).format(new Date(date)); }
export async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, { ...init, cache: 'no-store' });
  const data = await response.json();
  if (!response.ok) {
    if (response.status === 401 && !path.includes('/auth/login')) window.location.assign('/login');
    throw new Error(data.error || 'Something went wrong. Please try again.');
  }
  return data;
}
