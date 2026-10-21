import sharp from 'sharp';
import { FACE_DETECT_SCORE, FACE_NMS_IOU } from '../limits';
import type { Face, RgbImage } from '../types';
import { getSession, loadOrt } from './onnx';

/**
 * SCRFD-500M face detector (InsightFace buffalo_s `det_500m.onnx`), ported from insightface's
 * `SCRFD.detect`: 640×640 letterbox at the top-left, strides 8/16/32 with 2 anchors per cell,
 * distance-to-edge box decoding, then NMS.
 */

const INPUT_SIZE = 640;
const STRIDES = [8, 16, 32] as const;
const ANCHORS_PER_CELL = 2;

/** Resizes to fit 640×640 keeping aspect, padded right/bottom with black. Returns the scale applied. */
async function letterbox(rgb: RgbImage): Promise<{ pixels: Uint8Array; scale: number }> {
  const scale = Math.min(INPUT_SIZE / rgb.width, INPUT_SIZE / rgb.height);
  const w = Math.max(1, Math.round(rgb.width * scale));
  const h = Math.max(1, Math.round(rgb.height * scale));
  const pixels = await sharp(rgb.data, { raw: { width: rgb.width, height: rgb.height, channels: 3 } })
    .resize(w, h, { fit: 'fill' })
    .extend({ right: INPUT_SIZE - w, bottom: INPUT_SIZE - h, background: { r: 0, g: 0, b: 0 } })
    .raw()
    .toBuffer();
  return { pixels: new Uint8Array(pixels), scale: h / rgb.height };
}

/** HWC RGB bytes → NCHW float32, (x - 127.5) / 128 as in insightface. */
function toTensorData(pixels: Uint8Array): Float32Array {
  const plane = INPUT_SIZE * INPUT_SIZE;
  const out = new Float32Array(3 * plane);
  for (let i = 0; i < plane; i++) {
    out[i] = (pixels[i * 3] - 127.5) / 128;
    out[plane + i] = (pixels[i * 3 + 1] - 127.5) / 128;
    out[2 * plane + i] = (pixels[i * 3 + 2] - 127.5) / 128;
  }
  return out;
}

function iou(a: Face['box'], b: Face['box']): number {
  const x1 = Math.max(a[0], b[0]), y1 = Math.max(a[1], b[1]);
  const x2 = Math.min(a[0] + a[2], b[0] + b[2]), y2 = Math.min(a[1] + a[3], b[1] + b[3]);
  const inter = Math.max(0, x2 - x1) * Math.max(0, y2 - y1);
  return inter / (a[2] * a[3] + b[2] * b[3] - inter);
}

export function nms(faces: Face[], threshold: number): Face[] {
  const sorted = [...faces].sort((a, b) => b.score - a.score);
  const kept: Face[] = [];
  for (const face of sorted) {
    if (kept.every((k) => iou(k.box, face.box) <= threshold)) kept.push(face);
  }
  return kept;
}

/**
 * Decodes one stride's raw outputs. `scores` has one value per anchor, `boxes` four distances
 * (left, top, right, bottom) and `kps` ten offsets, all in units of `stride`, in letterbox pixels.
 * Anchors run row by row, two per cell, centred on the cell's top-left corner.
 */
export function decodeStride(
  stride: number,
  scores: Float32Array,
  boxes: Float32Array,
  kps: Float32Array,
  inputSize: number,
  threshold: number,
): Face[] {
  const cols = Math.ceil(inputSize / stride);
  const faces: Face[] = [];
  for (let i = 0; i < scores.length; i++) {
    const score = scores[i];
    if (score < threshold) continue;
    const cell = Math.floor(i / ANCHORS_PER_CELL);
    const cx = (cell % cols) * stride;
    const cy = Math.floor(cell / cols) * stride;
    const x1 = cx - boxes[i * 4] * stride;
    const y1 = cy - boxes[i * 4 + 1] * stride;
    const x2 = cx + boxes[i * 4 + 2] * stride;
    const y2 = cy + boxes[i * 4 + 3] * stride;
    const landmarks: [number, number][] = [];
    for (let k = 0; k < 5; k++) landmarks.push([cx + kps[i * 10 + k * 2] * stride, cy + kps[i * 10 + k * 2 + 1] * stride]);
    faces.push({ box: [x1, y1, x2 - x1, y2 - y1], score, landmarks });
  }
  return faces;
}

/** Faces in `rgb`, in its pixel coordinates, best first. */
export async function detectFaces(rgb: RgbImage): Promise<Face[]> {
  const [ort, session, { pixels, scale }] = await Promise.all([loadOrt(), getSession('detector'), letterbox(rgb)]);
  const input = new ort.Tensor('float32', toTensorData(pixels), [1, 3, INPUT_SIZE, INPUT_SIZE]);
  const outputs = await session.run({ [session.inputNames[0]]: input });
  // Outputs are ordered scores ×3, boxes ×3, keypoints ×3, each group by stride 8/16/32.
  const out = session.outputNames.map((name) => outputs[name].data as Float32Array);
  const fmc = STRIDES.length;

  const raw = STRIDES.flatMap((stride, s) =>
    decodeStride(stride, out[s], out[s + fmc], out[s + fmc * 2], INPUT_SIZE, FACE_DETECT_SCORE),
  );
  return nms(raw, FACE_NMS_IOU).map((face) => {
    // Back to source pixels, clipped to the image.
    const x1 = clamp(face.box[0] / scale, 0, rgb.width), y1 = clamp(face.box[1] / scale, 0, rgb.height);
    const x2 = clamp((face.box[0] + face.box[2]) / scale, 0, rgb.width);
    const y2 = clamp((face.box[1] + face.box[3]) / scale, 0, rgb.height);
    return {
      box: [x1, y1, x2 - x1, y2 - y1],
      score: face.score,
      landmarks: face.landmarks.map(([x, y]) => [x / scale, y / scale] as [number, number]),
    };
  });
}

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
