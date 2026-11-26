import type { Receipt } from "@dentalbook/domain-contracts";

export type ReceiptErrorCode = Extract<Receipt, { ok: false }>["errorCode"];

export class CenterError extends Error {
  constructor(
    public readonly code: ReceiptErrorCode,
    message: string,
    public readonly httpStatus: number,
  ) {
    super(message);
    this.name = "CenterError";
  }
}

export function asCenterError(error: unknown): CenterError {
  if (error instanceof CenterError) return error;
  return new CenterError("upstream_unavailable", "The center service could not complete the request.", 500);
}
