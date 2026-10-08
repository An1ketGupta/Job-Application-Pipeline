import {
  detectAtsPlatform,
  ApplicationDestinationUrlSchema,
  type ApplicationSchema,
} from '@careerlift/domain';

type Platform = ApplicationSchema['platform'];
const markers: { platform: Platform; host: RegExp }[] = [
  {
    platform: 'WORKDAY',
    host: /(?:^|\.)(?:myworkdayjobs\.com|workday\.com)$/,
  },
  {
    platform: 'SMARTRECRUITERS',
    host: /(?:^|\.)smartrecruiters\.com$/,
  },
  { platform: 'ICIMS', host: /(?:^|\.)icims\.com$/ },
  {
    platform: 'GOOGLE_FORM',
    host: /^forms\.google\.com$/,
  },
  {
    platform: 'GOOGLE_DOC',
    host: /^docs\.google\.com$/,
  },
  {
    platform: 'LINKEDIN',
    host: /(?:^|\.)linkedin\.com$/,
  },
];
export function detectPlatform(
  url: string,
  _signature: string,
  hasForm: boolean,
): { platform: Platform; confidence: number } {
  if (!ApplicationDestinationUrlSchema.safeParse(url).success)
    return { platform: 'UNKNOWN', confidence: 0 };
  const hostname = new URL(url).hostname.toLowerCase();
  const ats = detectAtsPlatform(url);
  if (ats) return { platform: ats, confidence: 0.99 };
  const pathname = new URL(url).pathname.toLowerCase();
  if (hostname === 'docs.google.com' && /^\/forms(?:\/|$)/.test(pathname))
    return { platform: 'GOOGLE_FORM', confidence: 0.99 };
  for (const item of markers) {
    if (item.host.test(hostname))
      return { platform: item.platform, confidence: 0.96 };
  }
  return {
    platform: hasForm ? 'GENERIC_PORTAL' : 'UNKNOWN',
    confidence: hasForm ? 0.55 : 0.2,
  };
}
