export class CliError extends Error {}

export function countLines(content) {
  return content.replace(/\n$/, "").split(/\n/).length;
}

export function fail(message) {
  throw new CliError(message);
}
