/** Every tunable number in the app. Read from here; never inline. */

/** Wrong access codes allowed per IP within GATE_WINDOW_MS before /gate locks that IP out. */
export const GATE_MAX_FAILS = 10;
export const GATE_WINDOW_MS = 15 * 60_000;
/** Pause before answering a wrong access code, to slow down guessing. */
export const GATE_FAIL_DELAY_MS = 400;
