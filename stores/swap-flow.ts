import { create } from 'zustand';
import type { ErrorCode, UploadView } from '@/lib/types';

/**
 * Ephemeral create-flow draft (steps 1–2). Not persisted: a reload starts over.
 * Every slot owns its preview object URL, which is revoked when the slot is replaced, removed or reset.
 */

export type SlotStatus = 'uploading' | 'checking' | 'ok' | 'rejected' | 'error';

export type SlotState = {
  localId: string;
  previewUrl: string;
  status: SlotStatus;
  /** Upload progress, 0–1. */
  progress: number;
  uploadId?: string;
  /** The server's view once the photo is checked. */
  upload?: UploadView;
  errorCode?: ErrorCode;
  isReference?: boolean;
  liveCheck?: 'ok' | 'warn' | null;
};

type SwapFlowState = {
  step: 1 | 2;
  template: SlotState | null;
  photos: SlotState[];
  setStep: (step: 1 | 2) => void;
  setTemplate: (slot: SlotState | null) => void;
  addPhotos: (slots: SlotState[]) => void;
  /** No-op if the slot is gone, so late results for a replaced photo are dropped. */
  updateSlot: (localId: string, patch: Partial<Omit<SlotState, 'localId'>>) => void;
  removeSlot: (localId: string) => void;
  reset: () => void;
};

const revoke = (slot: SlotState | null | undefined) => {
  if (slot?.previewUrl) URL.revokeObjectURL(slot.previewUrl);
};

export const useSwapFlow = create<SwapFlowState>()((set, get) => ({
  step: 1,
  template: null,
  photos: [],

  setStep: (step) => set({ step }),

  setTemplate: (slot) => {
    const previous = get().template;
    if (previous && previous.localId !== slot?.localId) revoke(previous);
    set({ template: slot });
  },

  addPhotos: (slots) => set((state) => ({ photos: [...state.photos, ...slots] })),

  updateSlot: (localId, patch) =>
    set((state) => {
      if (state.template?.localId === localId) return { template: { ...state.template, ...patch } };
      if (!state.photos.some((p) => p.localId === localId)) return state;
      return { photos: state.photos.map((p) => (p.localId === localId ? { ...p, ...patch } : p)) };
    }),

  removeSlot: (localId) => {
    const { template, photos } = get();
    if (template?.localId === localId) {
      revoke(template);
      set({ template: null });
      return;
    }
    revoke(photos.find((p) => p.localId === localId));
    set({ photos: photos.filter((p) => p.localId !== localId) });
  },

  reset: () => {
    const { template, photos } = get();
    revoke(template);
    photos.forEach(revoke);
    set({ step: 1, template: null, photos: [] });
  },
}));
