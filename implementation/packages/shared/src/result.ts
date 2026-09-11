/**
 * Explicit result type for domain operations whose failure is an expected
 * outcome rather than an exception, most importantly policy validation.
 */
export type Ok<T> = { readonly ok: true; readonly value: T };
export type Err<E> = { readonly ok: false; readonly error: E };
export type Result<T, E> = Ok<T> | Err<E>;

export const ok = <T>(value: T): Ok<T> => ({ ok: true, value });
export const err = <E>(error: E): Err<E> => ({ ok: false, error });

export const isOk = <T, E>(r: Result<T, E>): r is Ok<T> => r.ok;
export const isErr = <T, E>(r: Result<T, E>): r is Err<E> => !r.ok;

export const unwrap = <T, E>(r: Result<T, E>): T => {
  if (r.ok) return r.value;
  throw new Error(`unwrap() on an Err: ${JSON.stringify(r.error)}`);
};
