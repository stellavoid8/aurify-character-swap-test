import { expect, test } from '@playwright/test';
import {
  PHOTOS,
  addPhotos,
  expectNoHorizontalScroll,
  expectPhotosReady,
  expectResult,
  fixture,
  goToPhotos,
  login,
  makePicture,
  pickTemplate,
  rememberSession,
  versions,
} from './helpers/flow';
import { E2E } from './env';

test('core flow: template, two photos, one picture, download, try again, choose', async ({ page }) => {
  await test.step('gate', async () => {
    await page.goto('/gate');
    await expectNoHorizontalScroll(page);
    await login(page);
  });

  await test.step('step 1: template', async () => {
    await expectNoHorizontalScroll(page);
    await pickTemplate(page, PHOTOS.oneFace);
    // The step's one primary action is on screen without scrolling.
    await expect(page.getByRole('button', { name: 'Next: your photos' })).toBeInViewport();
    await expectNoHorizontalScroll(page);
    await goToPhotos(page);
  });

  await test.step('step 2: your photos', async () => {
    await addPhotos(page, [PHOTOS.oneFace, PHOTOS.oneFace]);
    await expectPhotosReady(page, 2);
    await expect(page.getByRole('button', { name: 'Make my picture' })).toBeInViewport();
    await expectNoHorizontalScroll(page);
  });

  const jobId = await test.step('step 3: waiting stages', async () => {
    const id = await makePicture(page);
    await expect(page.getByRole('heading', { name: 'Making your picture' })).toBeVisible();
    await expect(page.getByText('Looking at your template')).toBeVisible();
    await expect(page.getByText('Swapping you in')).toBeVisible();
    await expect(page.getByText('Checking the likeness')).toBeVisible();
    await expectNoHorizontalScroll(page);
    return id;
  });

  await test.step('result with one picture', async () => {
    await expectResult(page, 1);
    await expect(page.getByRole('figure').filter({ hasText: 'Result' })).toBeVisible();
    await expectNoHorizontalScroll(page);
  });

  await test.step('download', async () => {
    const download = page.waitForEvent('download');
    await page.getByRole('link', { name: 'Download' }).click();
    expect((await download).suggestedFilename()).toMatch(/^character-swap-[0-9a-f]{8}-\d\.jpg$/);
  });

  await test.step('try again adds a second picture', async () => {
    await page.getByRole('button', { name: 'Try again' }).click();
    // One mock image can finish before the waiting screen renders, so only the outcome is checked.
    await expectResult(page, 2);
    await expect(page.getByText('Earlier versions')).toBeVisible();
    await expectNoHorizontalScroll(page);
  });

  await test.step('choose version 2, and it survives a reload', async () => {
    const saved = page.waitForResponse(
      (res) => res.request().method() === 'POST' && new URL(res.url()).pathname === `/jobs/${jobId}`,
    );
    await versions(page).nth(1).click();
    await expect(versions(page).nth(1)).toHaveAttribute('aria-checked', 'true');
    await expect(page.getByRole('img', { name: 'Your result, version 2' }).first()).toBeVisible();
    await saved;
    await page.reload();
    await expect(versions(page).nth(1)).toHaveAttribute('aria-checked', 'true');
  });
});

test('keyboard only: gate and step 1', async ({ page, browserName }) => {
  // Safari only moves focus between form fields on Tab unless the user turns on full keyboard access.
  test.skip(browserName !== 'chromium', 'Tab order to buttons is checked in Chromium');

  await page.goto('/gate');
  // The code field has focus on load.
  await page.keyboard.type(E2E.accessCode);
  await page.keyboard.press('Enter');
  await expect(page.getByRole('heading', { name: 'Pick a photo to step into' })).toBeVisible();
  await rememberSession(page.context());

  // Tab reaches the photo picker and Enter opens it.
  const picker = page.locator('input[type="file"]');
  for (let i = 0; i < 10 && !(await picker.evaluate((el) => el === document.activeElement)); i++) {
    await page.keyboard.press('Tab');
  }
  await expect(picker).toBeFocused();
  const chooser = page.waitForEvent('filechooser');
  await page.keyboard.press('Enter');
  await (await chooser).setFiles(fixture(PHOTOS.oneFace));

  const next = page.getByRole('button', { name: 'Next: your photos' });
  await expect(next).toBeEnabled({ timeout: 90_000 });
  for (let i = 0; i < 10 && !(await next.evaluate((el) => el === document.activeElement)); i++) {
    await page.keyboard.press('Tab');
  }
  await expect(next).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(page.getByRole('heading', { name: 'Add photos of yourself' })).toBeVisible();
});
