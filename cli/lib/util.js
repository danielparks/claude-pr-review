export class CliError extends Error {}

export function fail(message) {
  throw new CliError(message);
}
