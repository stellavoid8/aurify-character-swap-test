import { NextResponse, type NextRequest } from 'next/server';
import { ERRORS } from '@/lib/errors';
import { SESSION_COOKIE, verifySession } from '@/lib/session';

/** Paths that skip the access-code check. The webhook and cron routes authenticate themselves. */
const PUBLIC_PATHS = ['/gate', '/api/webhooks/fal', '/api/cron/cleanup'];

function isPublic(pathname: string): boolean {
  return PUBLIC_PATHS.some((path) => pathname === path || pathname.startsWith(`${path}/`));
}

export async function middleware(request: NextRequest) {
  const { pathname, search } = request.nextUrl;
  if (isPublic(pathname)) return NextResponse.next();

  const session = await verifySession(request.cookies.get(SESSION_COOKIE)?.value);
  if (session) return NextResponse.next();

  // API calls and Server Action POSTs are fetches, so they get JSON rather than a redirect to an HTML page.
  if (pathname.startsWith('/api/') || request.headers.has('next-action')) {
    return NextResponse.json(
      { error: { code: 'ACCESS_DENIED', message: ERRORS.ACCESS_DENIED.message } },
      { status: ERRORS.ACCESS_DENIED.status },
    );
  }

  const gate = new URL('/gate', request.url);
  gate.searchParams.set('next', `${pathname}${search}`);
  return NextResponse.redirect(gate);
}

export const config = {
  matcher: ['/((?!_next/static|_next/image|favicon\\.ico|seed/|models/).*)'],
};
