import { z } from 'zod';

// Syntax and destination policy are separate: a URL may parse while being unsafe
// for an application executor. Network access still needs executor-side controls.
export const UrlSyntaxSchema = z.string().url();
export const ApplicationDestinationUrlSchema = UrlSyntaxSchema.refine(
  (value) => {
    const url = new URL(value);
    return (
      url.protocol === 'https:' &&
      url.hostname.length > 0 &&
      !url.username &&
      !url.password
    );
  },
  {
    message: 'Application destinations must be HTTPS URLs without credentials',
  },
);
