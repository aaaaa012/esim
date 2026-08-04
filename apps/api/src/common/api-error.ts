import { HttpException, HttpStatus } from '@nestjs/common';

/**
 * Typed API error.
 *
 * - `code` — stable public error code from the shared taxonomy.
 * - `message` — customer-safe message; shown verbatim to the client.
 * - `details` — internal diagnostic detail (provider responses, etc.); logged
 *   server-side but never serialized into the HTTP response.
 */
export type ApiErrorInput = {
  code: string;
  message: string;
  status?: number;
  details?: unknown;
};

export class ApiException extends HttpException {
  readonly code: string;
  readonly internalDetail?: unknown;

  constructor(input: ApiErrorInput) {
    super(
      { code: input.code, message: input.message },
      input.status ?? HttpStatus.BAD_REQUEST,
    );
    this.code = input.code;
    this.internalDetail = input.details;
  }
}
