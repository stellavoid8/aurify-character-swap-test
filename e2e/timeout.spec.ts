import { expect, test } from '@playwright/test';
import { ERRORS } from '../lib/errors';
import { seedOverdueJob } from './helpers/db';
import { login } from './helpers/flow';

test('a job past its deadline shows the timed-out screen with Try again', async ({ page }) => {
  const sid = await login(page);
  // A running job whose deadline_at has passed: the next read times it out (lib/pipeline/timeout.ts).
  const jobId = await seedOverdueJob(sid);
  await page.goto(`/jobs/${jobId}`);
  await expect(page.getByRole('heading', { name: ERRORS.JOB_TIMED_OUT.message })).toBeVisible();
  await expect(page.getByText(ERRORS.JOB_TIMED_OUT.nextStep, { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Try again' })).toBeEnabled();
});
