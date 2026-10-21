import type { ERRORS, NOTICES } from './errors';

export type ErrorCode = keyof typeof ERRORS;
export type NoticeCode = keyof typeof NOTICES;

/** Error shape sent to the browser by Server Actions and Route Handlers. */
export type ApiError = { code: ErrorCode; message: string };

export type ActionResult<T> = { ok: true; data: T } | { ok: false; error: ApiError };

/** JSON body of every Route Handler response. */
export type ApiResponse<T> = { data: T } | { error: ApiError };
