import { pino, type DestinationStream, type Logger as PinoLogger } from "pino";
import { redact, REDACTED } from "./redact.js";

export type Logger = PinoLogger;

/** Key paths censored by pino itself (defense in depth; values are also scrubbed via formatters). */
export const REDACT_PATHS = [
  "apiKey",
  "token",
  "secret",
  "password",
  "authorization",
  "headers.authorization",
  "headers.cookie",
  "env.*",
  "*.apiKey",
  "*.token",
  "*.secret",
  "*.password",
  "*.authorization",
];

export function createLogger(opts: {
  name: string;
  level?: string;
  destination?: DestinationStream;
}): Logger {
  return pino(
    {
      name: opts.name,
      level: opts.level ?? "info",
      redact: { paths: REDACT_PATHS, censor: REDACTED },
      formatters: {
        log: (obj) => redact(obj),
      },
      hooks: {
        // Scrub credential-shaped substrings inside log messages.
        logMethod(args, method) {
          const scrubbed = args.map((a) => (typeof a === "string" ? redact(a) : a));
          return method.apply(this, scrubbed as Parameters<typeof method>);
        },
      },
    },
    opts.destination,
  );
}
