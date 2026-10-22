import { beforeEach, describe, expect, it, vi } from 'vitest';
import { MAX_USER_PHOTOS } from '@/lib/limits';
import type { UploadView } from '@/lib/types';
import { pickReference, useSwapFlow, type SlotState } from '@/stores/swap-flow';

const revokeObjectURL = vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {});

function slot(localId: string, patch: Partial<SlotState> = {}): SlotState {
  return { localId, previewUrl: `blob:${localId}`, status: 'uploading', progress: 0, ...patch };
}

function view(qualityScore: number | null): UploadView {
  return {
    id: `upload-${qualityScore}`,
    kind: 'user',
    status: 'ok',
    rejectCode: null,
    url: 'https://example.test/photo.jpg',
    width: 1000,
    height: 1000,
    faceCount: 1,
    subjectBox: null,
    qualityScore,
  };
}

const store = () => useSwapFlow.getState();
const ids = () => store().photos.map((p) => p.localId);

beforeEach(() => {
  store().reset();
  revokeObjectURL.mockClear();
});

describe('photos', () => {
  it('adds and removes photos, revoking the removed preview', () => {
    store().addPhotos([slot('a'), slot('b')]);
    expect(ids()).toEqual(['a', 'b']);

    store().removeSlot('a');
    expect(ids()).toEqual(['b']);
    expect(revokeObjectURL).toHaveBeenCalledWith('blob:a');
  });

  it(`keeps at most ${MAX_USER_PHOTOS} photos and returns the ones it kept`, () => {
    store().addPhotos([slot('a'), slot('b'), slot('c')]);
    const kept = store().addPhotos([slot('d'), slot('e'), slot('f')]);

    expect(kept.map((s) => s.localId)).toEqual(['d']);
    expect(ids()).toEqual(['a', 'b', 'c', 'd']);
    expect(revokeObjectURL).toHaveBeenCalledWith('blob:e');
    expect(revokeObjectURL).toHaveBeenCalledWith('blob:f');

    expect(store().addPhotos([slot('g')])).toEqual([]);
    expect(ids()).toHaveLength(MAX_USER_PHOTOS);
  });

  it('frees a slot when a photo is removed', () => {
    store().addPhotos([slot('a'), slot('b'), slot('c'), slot('d')]);
    store().removeSlot('b');
    expect(store().addPhotos([slot('e')]).map((s) => s.localId)).toEqual(['e']);
    expect(ids()).toEqual(['a', 'c', 'd', 'e']);
  });

  it('drops updates for a removed photo', () => {
    store().addPhotos([slot('a')]);
    store().removeSlot('a');
    store().updateSlot('a', { status: 'ok', upload: view(0.5) });
    expect(store().photos).toEqual([]);
    expect(store().referenceLocalId).toBeNull();
  });
});

describe('reference photo', () => {
  it('is the ok photo with the highest quality score', () => {
    store().addPhotos([slot('a'), slot('b'), slot('c')]);
    expect(store().referenceLocalId).toBeNull();

    store().updateSlot('a', { status: 'ok', upload: view(0.2) });
    expect(store().referenceLocalId).toBe('a');

    store().updateSlot('b', { status: 'ok', upload: view(0.6) });
    expect(store().referenceLocalId).toBe('b');

    // A rejected photo never becomes the reference.
    store().updateSlot('c', { status: 'rejected', errorCode: 'NO_FACE', upload: view(0.9) });
    expect(store().referenceLocalId).toBe('b');
  });

  it('moves to the next best photo when the reference is removed', () => {
    store().addPhotos([slot('a', { status: 'ok', upload: view(0.2) }), slot('b', { status: 'ok', upload: view(0.6) })]);
    expect(store().referenceLocalId).toBe('b');

    store().removeSlot('b');
    expect(store().referenceLocalId).toBe('a');

    store().removeSlot('a');
    expect(store().referenceLocalId).toBeNull();
  });

  it('prefers the earlier photo on a tie and treats a missing score as lowest', () => {
    expect(
      pickReference([
        slot('a', { status: 'ok', upload: view(null) }),
        slot('b', { status: 'ok', upload: view(0.4) }),
        slot('c', { status: 'ok', upload: view(0.4) }),
      ]),
    ).toBe('b');
    expect(pickReference([slot('a', { status: 'ok' }), slot('b', { status: 'ok' })])).toBe('a');
  });

  it('is cleared by reset', () => {
    store().addPhotos([slot('a', { status: 'ok', upload: view(0.5) })]);
    store().reset();
    expect(store().referenceLocalId).toBeNull();
    expect(store().photos).toEqual([]);
  });
});
