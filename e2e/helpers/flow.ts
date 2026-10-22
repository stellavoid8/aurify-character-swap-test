import { appendFileSync } from 'node:fs';
import path from 'node:path';
import { expect, type BrowserContext, type Page } from '@playwright/test';
import { E2E } from '../env';

/** The mock face engine reads the photo's colour: grey = one face, red = no face, blue = two faces. */
export const PHOTOS = {
  oneFace: 'face-one-grey.jpg',
  noFace: 'face-none-red.jpg',
  group: 'face-two-blue.jpg',
  pdf: 'sample.pdf',
  /** Over 25 MB, written by global-setup.ts. */
  big: 'big.jpg',
} as const;

export const fixture = (name: string) => path.join(__dirname, '..', 'fixtures', name);

/** Session ids the specs created, one per line; global-teardown.ts deletes their rows and files. */
export const SESSIONS_FILE = path.join(process.cwd(), 'test-results', '.e2e-sessions');

/** Whole-job waits: a cold dev server compiles the job routes on first use. */
const JOB_TIMEOUT = 90_000;

/** The `sid` inside the signed `cs_session` cookie (`base64url(json).signature`). */
export async function sidOf(context: BrowserContext): Promise<string> {
  const cookie = (await context.cookies()).find((c) => c.name === 'cs_session');
  if (!cookie) throw new Error('no cs_session cookie: the gate was not passed');
  const [body] = cookie.value.split('.');
  return (JSON.parse(Buffer.from(body, 'base64url').toString('utf8')) as { sid: string }).sid;
}

export async function submitCode(page: Page, code: string): Promise<void> {
  await page.getByLabel('Access code').fill(code);
  await page.getByRole('button', { name: 'Continue' }).click();
}

/** Opens the app, gets sent to /gate, enters the code and lands on step 1. Returns the session id. */
export async function login(page: Page): Promise<string> {
  await page.goto('/');
  await expect(page).toHaveURL(/\/gate/);
  await submitCode(page, E2E.accessCode);
  await expect(page.getByRole('heading', { name: 'Pick a photo to step into' })).toBeVisible();
  return rememberSession(page.context());
}

/** Notes the context's session for global-teardown.ts. Returns its id. */
export async function rememberSession(context: BrowserContext): Promise<string> {
  const sid = await sidOf(context);
  appendFileSync(SESSIONS_FILE, `${sid}\n`);
  return sid;
}

/** Step 1: picks the template and waits until it has passed the server check. */
export async function pickTemplate(page: Page, name: string = PHOTOS.oneFace): Promise<void> {
  await page.locator('input[type="file"]').first().setInputFiles(fixture(name));
  await expect(page.getByRole('button', { name: 'Next: your photos' })).toBeEnabled({ timeout: JOB_TIMEOUT });
}

export async function goToPhotos(page: Page): Promise<void> {
  await page.getByRole('button', { name: 'Next: your photos' }).click();
  await expect(page.getByRole('heading', { name: 'Add photos of yourself' })).toBeVisible();
}

/** Step 2: adds photos in one pick. Doesn't wait; callers assert the outcome they expect. */
export async function addPhotos(page: Page, names: string[]): Promise<void> {
  await page.locator('input[type="file"]').setInputFiles(names.map(fixture));
}

export async function expectPhotosReady(page: Page, count: number): Promise<void> {
  await expect(page.getByRole('img', { name: /^Photo \d: ready$/ })).toHaveCount(count, { timeout: JOB_TIMEOUT });
}

/** Taps Make my picture and waits for the job page. Returns the job id. */
export async function makePicture(page: Page): Promise<string> {
  await page.getByRole('button', { name: 'Make my picture' }).click();
  await page.waitForURL(/\/jobs\/[0-9a-f-]{36}$/, { timeout: JOB_TIMEOUT });
  return new URL(page.url()).pathname.split('/').pop()!;
}

export function versions(page: Page) {
  return page.getByRole('radiogroup', { name: 'Versions' }).getByRole('radio');
}

export async function expectResult(page: Page, count: number): Promise<void> {
  await expect(page.getByRole('heading', { name: "Here's your picture" })).toBeVisible({ timeout: JOB_TIMEOUT });
  await expect(versions(page)).toHaveCount(count);
}

/** Login through to a finished job with one user photo. Returns the session and job ids. */
export async function finishedJob(page: Page): Promise<{ sid: string; jobId: string }> {
  const sid = await login(page);
  await pickTemplate(page);
  await goToPhotos(page);
  await addPhotos(page, [PHOTOS.oneFace]);
  await expectPhotosReady(page, 1);
  const jobId = await makePicture(page);
  await expectResult(page, 3);
  return { sid, jobId };
}

/** Narrows the page to 360 px, checks nothing overflows sideways, then restores the viewport. */
export async function expectNoHorizontalScroll(page: Page): Promise<void> {
  const original = page.viewportSize();
  await page.setViewportSize({ width: 360, height: original?.height ?? 740 });
  const overflow = await page.evaluate(
    () =>
      new Promise<number>((resolve) =>
        requestAnimationFrame(() => resolve(document.documentElement.scrollWidth - document.documentElement.clientWidth)),
      ),
  );
  if (original) await page.setViewportSize(original);
  expect(overflow, 'page is wider than a 360 px screen').toBeLessThanOrEqual(0);
}
