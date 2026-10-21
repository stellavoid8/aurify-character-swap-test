'use client';

import { useActionState, useEffect, useId, useRef, useState } from 'react';
import { Button } from '@/components/ui/Button';
import { Notice } from '@/components/ui/Notice';
import { ERRORS } from '@/lib/errors';
import { submitGate, type GateState } from '@/server/gate/actions';

export function GateForm({ next }: { next: string }) {
  const [state, formAction, pending] = useActionState<GateState, FormData>(submitGate, null);
  // Controlled so React's post-action form reset keeps the text, which is then selected for retyping.
  const [code, setCode] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);
  const inputId = useId();
  const errorId = useId();
  const error = state && !state.ok ? state.error : null;

  useEffect(() => {
    if (!error) return;
    inputRef.current?.focus();
    inputRef.current?.select();
  }, [state, error]);

  return (
    <form action={formAction} className="flex flex-col gap-4" noValidate>
      <input type="hidden" name="next" value={next} />
      <div className="flex flex-col gap-2">
        <label htmlFor={inputId} className="text-small font-medium">
          Access code
        </label>
        <input
          ref={inputRef}
          id={inputId}
          name="code"
          type="text"
          value={code}
          onChange={(event) => setCode(event.target.value)}
          autoFocus
          autoComplete="off"
          autoCapitalize="none"
          autoCorrect="off"
          spellCheck={false}
          enterKeyHint="go"
          maxLength={64}
          aria-invalid={error ? true : undefined}
          aria-describedby={error ? errorId : undefined}
          className="h-12 rounded-md border border-line bg-surface px-4 text-body text-ink focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent aria-invalid:border-danger"
        />
      </div>
      {error && (
        <div id={errorId}>
          <Notice tone="danger" title={ERRORS[error.code].message}>
            {ERRORS[error.code].nextStep}
          </Notice>
        </div>
      )}
      <Button type="submit" size="lg" loading={pending}>
        Continue
      </Button>
    </form>
  );
}
