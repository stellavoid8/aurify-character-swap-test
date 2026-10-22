'use client';

import { ButtonLink } from '@/components/ui/Button';
import { useSwapFlow } from '@/stores/swap-flow';

/** Back to step 1 with an empty draft. */
export function StartOverLink() {
  const reset = useSwapFlow((s) => s.reset);
  return (
    <ButtonLink href="/" variant="ghost" onClick={reset}>
      Start a new picture
    </ButtonLink>
  );
}
