import { setTimeout as delay } from 'node:timers/promises';
import type { Page } from 'playwright';

// DOMContentLoaded only establishes that the page shell exists. Hosted forms
// often arrive later, and can render their controls in several batches.
export async function waitForFormRendering(page: Page, timeoutMs = 10000) {
  const deadline = Date.now() + timeoutMs;
  let previous = '',
    stableSince = 0;
  while (Date.now() < deadline) {
    const snapshot = await page.evaluate(() => {
      const fields = Array.from(
        document.querySelectorAll<HTMLElement>(
          'input,textarea,select,[role="combobox"],[role="textbox"],[role="checkbox"],[role="radio"]',
        ),
      ).filter((element) => {
        if (
          element instanceof HTMLInputElement &&
          ['hidden', 'submit', 'button', 'reset', 'image'].includes(
            element.type,
          )
        )
          return false;
        const rect = element.getBoundingClientRect();
        const style = getComputedStyle(element);
        return (
          rect.width > 0 &&
          rect.height > 0 &&
          style.display !== 'none' &&
          style.visibility !== 'hidden' &&
          !element.closest('[hidden],[aria-hidden="true"]')
        );
      });
      const text = `${document.title} ${document.body?.innerText ?? ''}`;
      const challenge =
        /recaptcha|hcaptcha|cf-turnstile|cloudflare challenge|verify you are human|captcha|sign in to apply|log in to apply|login required|account required/i.test(
          text,
        );
      return {
        challenge,
        fingerprint: fields.length
          ? JSON.stringify(
              fields.map((f) => [
                f.tagName,
                f.id,
                f.getAttribute('name'),
                f.getAttribute('type'),
                f.getAttribute('role'),
                f.getAttribute('aria-label'),
                (f as HTMLInputElement).labels?.[0]?.textContent,
                f instanceof HTMLSelectElement
                  ? Array.from(f.options).map((o) => [o.value, o.textContent])
                  : null,
              ]),
            )
          : '',
      };
    });
    if (snapshot.challenge) return;
    if (snapshot.fingerprint && snapshot.fingerprint === previous) {
      if (Date.now() - stableSince >= 300) return;
    } else {
      previous = snapshot.fingerprint;
      stableSince = Date.now();
    }
    await delay(Math.min(100, Math.max(0, deadline - Date.now())));
  }
}
