import { redirect } from 'next/navigation';
import { AppHeader } from '@/components/ui/AppHeader';
import { requireSession } from '@/lib/session';

// Middleware already guards these routes; this check is defense in depth.
export default async function AppLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  const session = await requireSession().catch(() => null);
  if (!session) redirect('/gate');

  return (
    <>
      <AppHeader />
      {children}
    </>
  );
}
