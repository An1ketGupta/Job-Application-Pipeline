import {
  chromium,
  type Browser,
  type BrowserContext,
  type Page,
} from 'playwright';
import { DestinationPolicy } from './policy.js';
import { googleSessionState } from './google-session.js';

export class GoogleAccountLogin {
  private constructor(
    private readonly browser: Browser,
    readonly context: BrowserContext,
    readonly page: Page,
  ) {}
  static async open() {
    if (process.env.VITEST || process.env.NODE_ENV === 'test')
      throw new Error('GOOGLE_FORMS_TEST_FIXTURE_REQUIRED');
    // Google rejects Playwright's bundled Chromium as an unsafe sign-in
    // browser. Use the installed Chrome channel for the manual login window
    // and remove only Playwright's automation marker; credentials are still
    // entered by the user in the visible browser.
    const browser = await chromium.launch({
      channel: 'chrome',
      headless: false,
      ignoreDefaultArgs: ['--enable-automation'],
      args: ['--disable-blink-features=AutomationControlled'],
    });
    try {
      const context = await browser.newContext({
        serviceWorkers: 'block',
        acceptDownloads: false,
        locale: 'en-US',
      });
      const policy = new DestinationPolicy();
      const hosts = new Set([
        'accounts.google.com',
        'myaccount.google.com',
        'google.com',
        'www.google.com',
        'www.gstatic.com',
        'ssl.gstatic.com',
        'fonts.gstatic.com',
        'apis.google.com',
      ]);
      await context.routeWebSocket('**/*', (socket) => socket.close());
      await context.route('**/*', async (route) => {
        try {
          const request = route.request(),
            url = new URL(request.url());
          if (!hosts.has(url.hostname))
            throw new Error('GOOGLE_LOGIN_HOST_BLOCKED');
          await policy.validateAddress(url.href);
          if (
            request.isNavigationRequest() &&
            ![
              'accounts.google.com',
              'myaccount.google.com',
              'google.com',
              'www.google.com',
            ].includes(url.hostname)
          )
            throw new Error('GOOGLE_LOGIN_NAVIGATION_BLOCKED');
          await route.continue();
        } catch {
          await route.abort();
        }
      });
      const page = await context.newPage();
      context.on('page', (popup) => {
        if (popup !== page) void popup.close();
      });
      await page.goto(
        'https://accounts.google.com/ServiceLogin?continue=https%3A%2F%2Fmyaccount.google.com%2F',
        { waitUntil: 'domcontentloaded', timeout: 30000 },
      );
      return new GoogleAccountLogin(browser, context, page);
    } catch (error) {
      await browser.close();
      throw error;
    }
  }
  async confirm(expectedAccount: string) {
    if (this.page.isClosed()) throw new Error('GOOGLE_FORMS_SESSION_LOST');
    await this.page.goto('https://myaccount.google.com/', {
      waitUntil: 'domcontentloaded',
      timeout: 30000,
    });
    if (new URL(this.page.url()).hostname !== 'myaccount.google.com')
      throw new Error('GOOGLE_FORMS_AUTHENTICATION_REQUIRED');
    const header = this.page.locator(
      '[aria-label*="Google Account"],a[href*="SignOutOptions"]',
    );
    const labels = await header.evaluateAll((elements) =>
      elements.map((e) => e.getAttribute('aria-label') ?? ''),
    );
    const accounts = labels.flatMap(
      (label) => label.match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi) ?? [],
    );
    if (
      !accounts.length ||
      accounts.some(
        (account) => account.toLowerCase() !== expectedAccount.toLowerCase(),
      )
    )
      throw new Error('GOOGLE_FORMS_ACCOUNT_MISMATCH');
    return googleSessionState(await this.context.storageState());
  }
  async close() {
    await this.browser.close().catch(() => {});
  }
}
