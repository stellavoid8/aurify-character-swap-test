'use client';

import { useEffect } from 'react';
import { StepIndicator } from '@/components/ui/StepIndicator';
import { useSwapFlow } from '@/stores/swap-flow';
import { PhotosStep } from './PhotosStep';
import { TemplateStep } from './TemplateStep';

const STEP_PARAM = 'step';

const urlStep = (): 1 | 2 => (new URLSearchParams(window.location.search).get(STEP_PARAM) === '2' ? 2 : 1);

/**
 * Steps 1–2 of the create flow, driven by the draft store. Step 2 is pushed as `?step=2`, so the
 * browser back button returns to step 1. The draft isn't persisted, so a reload always starts at step 1.
 */
export function CreateFlow({ sid }: { sid: string }) {
  const step = useSwapFlow((s) => s.step);
  const setStep = useSwapFlow((s) => s.setStep);

  useEffect(() => {
    // A reload or shared link on ?step=2 has no draft behind it.
    if (urlStep() === 2 && useSwapFlow.getState().template?.status !== 'ok') {
      window.history.replaceState(null, '', window.location.pathname);
      setStep(1);
    }
    const onPopState = () => {
      const target = urlStep();
      setStep(target === 2 && useSwapFlow.getState().template?.status === 'ok' ? 2 : 1);
    };
    window.addEventListener('popstate', onPopState);
    return () => window.removeEventListener('popstate', onPopState);
  }, [setStep]);

  useEffect(() => {
    window.scrollTo({ top: 0 });
  }, [step]);

  const goToPhotos = () => {
    window.history.pushState(null, '', `?${STEP_PARAM}=2`);
    setStep(2);
  };

  return (
    <div className="flex flex-col gap-6">
      <StepIndicator current={step} />
      {step === 1 ? (
        <TemplateStep sid={sid} onNext={goToPhotos} />
      ) : (
        <PhotosStep sid={sid} onBack={() => window.history.back()} />
      )}
    </div>
  );
}
