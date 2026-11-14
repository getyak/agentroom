export class GroupRequestError extends Error {
  constructor(message: string, readonly status: number, readonly code = '') { super(message); }
}
export const definiteGroupRejection = (error: unknown) => error instanceof GroupRequestError && error.status >= 400 && error.status < 500 && !['idempotency_conflict', 'operation_unknown'].includes(error.code);
