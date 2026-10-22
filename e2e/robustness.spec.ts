import { expect, test } from '@playwright/test';
import { ERRORS } from '../lib/errors';
import { jobSnapshot, seedRounds, succeededCandidate, webhookPath } from './helpers/db';
import {
  PHOTOS,
  addPhotos,
  expectPhotosReady,
  finishedJob,
  fixture,
  goToPhotos,
  login,
  makePicture,
  pickTemplate,
  submitCode,
} from './helpers/flow';

test('a wrong access code is refused', async ({ page }) => {
  await page.goto('/gate');
  await submitCode(page, 'definitely-not-the-code');
  await expect(page.getByText(ERRORS.INVALID_ACCESS_CODE.message, { exact: true })).toBeVisible();
  await expect(page).toHaveURL(/\/gate/);
});

test('every route is blocked without the session cookie', async ({ request }) => {
  // `request` is its own cookie jar, so these calls carry no session.
  for (const path of ['/', '/jobs/x']) {
    const res = await request.get(path, { maxRedirects: 0 });
    expect(res.status(), path).toBe(307);
    expect(new URL(res.headers().location, 'http://x').pathname, path).toBe('/gate');
  }
  const calls = [
    request.post('/api/jobs', { data: {} }),
    request.get('/api/jobs/x'),
    request.post('/api/blob/upload', { data: {} }),
  ];
  for (const res of await Promise.all(calls)) {
    expect(res.status(), res.url()).toBe(401);
    expect((await res.json()).error.code).toBe('ACCESS_DENIED');
  }
});

test('a PDF and a photo over 25 MB get a clear message', async ({ page }) => {
  await login(page);
  const picker = page.locator('input[type="file"]');
  await picker.setInputFiles(fixture(PHOTOS.pdf));
  await expect(page.getByText(ERRORS.UNSUPPORTED_FILE_TYPE.message, { exact: true })).toBeVisible();
  await picker.setInputFiles(fixture(PHOTOS.big));
  await expect(page.getByText(ERRORS.FILE_TOO_LARGE.message, { exact: true })).toBeVisible();
});

test('a photo with no face and a group photo are each named', async ({ page }) => {
  await login(page);
  await pickTemplate(page);
  await goToPhotos(page);
  await addPhotos(page, [PHOTOS.noFace, PHOTOS.group]);
  await expect(page.getByText(ERRORS.NO_FACE.message, { exact: true })).toBeVisible({ timeout: 90_000 });
  await expect(page.getByText(ERRORS.MULTIPLE_FACES.message, { exact: true })).toBeVisible({ timeout: 90_000 });
  expect(ERRORS.NO_FACE.message).toContain("We can't see a face");
  expect(ERRORS.MULTIPLE_FACES.message).toContain('more than one person');
  await expect(page.getByRole('button', { name: 'Make my picture' })).toBeDisabled();
});

test('the 21st unit of the day gets the polite limit message', async ({ page }) => {
  const sid = await login(page);
  await seedRounds(sid, 20);
  await pickTemplate(page);
  await goToPhotos(page);
  await addPhotos(page, [PHOTOS.oneFace]);
  await expectPhotosReady(page, 1);
  await page.getByRole('button', { name: 'Make my picture' }).click();
  await expect(page.getByText(ERRORS.RATE_LIMITED_SESSION.message, { exact: true })).toBeVisible();
  await expect(page.getByText(ERRORS.RATE_LIMITED_SESSION.nextStep, { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Make my picture' })).toBeDisabled();
});

test('a replayed webhook does not change a finished job', async ({ page }) => {
  const { jobId } = await finishedJob(page);
  const before = await jobSnapshot(jobId);
  expect(before.status).toBe('succeeded');

  const candidate = await succeededCandidate(jobId);
  const body = { request_id: candidate.requestId, status: 'OK', payload: { images: [{ url: candidate.imageUrl }] } };
  const replay = await page.request.post(webhookPath(candidate.id, candidate.attempt), { data: body });
  expect(replay.status()).toBe(200);
  expect((await replay.json()).data).toEqual({ duplicate: true });

  // A forged token is turned away before the body is read.
  const forged = await page.request.post(`${webhookPath(candidate.id, candidate.attempt).slice(0, -4)}AAAA`, { data: body });
  expect(forged.status()).toBe(401);

  expect(await jobSnapshot(jobId)).toEqual(before);
});

test('a provider that keeps failing ends on the failed screen with Try again @provider-failure', async ({ page }) => {
  await login(page);
  await pickTemplate(page);
  await goToPhotos(page);
  await addPhotos(page, [PHOTOS.oneFace]);
  await expectPhotosReady(page, 1);
  await makePicture(page);
  // Each candidate fails, is retried once automatically, and fails again.
  await expect(page.getByRole('heading', { name: ERRORS.GENERATION_FAILED.message })).toBeVisible({ timeout: 90_000 });
  await expect(page.getByText(ERRORS.GENERATION_FAILED.nextStep, { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Try again' })).toBeEnabled();
});
