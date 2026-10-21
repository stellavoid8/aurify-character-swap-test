import { ImageOff } from 'lucide-react';
import { AppHeader } from '@/components/ui/AppHeader';
import { ButtonLink } from '@/components/ui/Button';
import { EmptyState } from '@/components/ui/EmptyState';

export default function NotFound() {
  return (
    <>
      <AppHeader />
      <main className="mx-auto w-full max-w-5xl px-4 py-12 md:px-8">
        <EmptyState
          icon={<ImageOff />}
          title="We can't find that page"
          body="The link may be old or mistyped."
          action={
            <ButtonLink href="/" size="lg">
              Start a new picture
            </ButtonLink>
          }
        />
      </main>
    </>
  );
}
