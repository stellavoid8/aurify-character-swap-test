import { create } from 'zustand';
import { MAX_USER_PHOTOS } from '@/lib/limits';
import type { ErrorCode, UploadView } from '@/lib/types';

/**
 * Ephemeral create-flow draft (steps 1–2). Not persisted: a reload starts over.
 * Every slot owns its preview object URL, which is revoked when the slot is replaced, removed or reset.
 */

export type SlotStatus = 'uploading' | 'checking' | 'ok' | 'rejected' | 'error';

export type SlotState = {
  localId: string;
  /** An object URL of the picked file: an image, or for a template clip a video. */
  previewUrl: string;
  mediaType?: 'image' | 'video';
  status: SlotStatus;
  /** Upload progress, 0–1. */
  progress: number;
  uploadId?: string;
  /** The server's view once the photo is checked. */
  upload?: UploadView;
  errorCode?: ErrorCode;
  /** The in-browser face check: advisory only, the server check replaces it. null when it couldn't run. */
  liveCheck?: 'ok' | 'warn' | null;
};

type SwapFlowState = {
  step: 1 | 2;
  template: SlotState | null;
  photos: SlotState[];
  /** The ok photo with the highest quality score: the "Main photo". */
  referenceLocalId: string | null;
  setStep: (step: 1 | 2) => void;
  setTemplate: (slot: SlotState | null) => void;
  /** Adds up to MAX_USER_PHOTOS in total and returns the slots it kept; the caller drops the rest. */
  addPhotos: (slots: SlotState[]) => SlotState[];
  /** No-op if the slot is gone, so late results for a replaced photo are dropped. */
  updateSlot: (localId: string, patch: Partial<Omit<SlotState, 'localId'>>) => void;
  removeSlot: (localId: string) => void;
  reset: () => void;
};

const revoke = (slot: SlotState | null | undefined) => {
  if (slot?.previewUrl) URL.revokeObjectURL(slot.previewUrl);
};

/** The ok photo with the highest quality score; the earlier photo wins a tie. */
export function pickReference(photos: SlotState[]): string | null {
  let best: SlotState | null = null;
  for (const photo of photos) {
    if (photo.status !== 'ok') continue;
    if (!best || (photo.upload?.qualityScore ?? -1) > (best.upload?.qualityScore ?? -1)) best = photo;
  }
  return best?.localId ?? null;
}

const withPhotos = (photos: SlotState[]) => ({ photos, referenceLocalId: pickReference(photos) });

export const useSwapFlow = create<SwapFlowState>()((set, get) => ({
  step: 1,
  template: null,
  photos: [],
  referenceLocalId: null,

  setStep: (step) => set({ step }),

  setTemplate: (slot) => {
    const previous = get().template;
    if (previous && previous.localId !== slot?.localId) revoke(previous);
    set({ template: slot });
  },

  addPhotos: (slots) => {
    const { photos } = get();
    const kept = slots.slice(0, Math.max(0, MAX_USER_PHOTOS - photos.length));
    slots.slice(kept.length).forEach(revoke);
    if (kept.length > 0) set(withPhotos([...photos, ...kept]));
    return kept;
  },

  updateSlot: (localId, patch) =>
    set((state) => {
      if (state.template?.localId === localId) return { template: { ...state.template, ...patch } };
      if (!state.photos.some((p) => p.localId === localId)) return state;
      return withPhotos(state.photos.map((p) => (p.localId === localId ? { ...p, ...patch } : p)));
    }),

  removeSlot: (localId) => {
    const { template, photos } = get();
    if (template?.localId === localId) {
      revoke(template);
      set({ template: null });
      return;
    }
    revoke(photos.find((p) => p.localId === localId));
    set(withPhotos(photos.filter((p) => p.localId !== localId)));
  },

  reset: () => {
    const { template, photos } = get();
    revoke(template);
    photos.forEach(revoke);
    set({ step: 1, template: null, photos: [], referenceLocalId: null });
  },
}));
