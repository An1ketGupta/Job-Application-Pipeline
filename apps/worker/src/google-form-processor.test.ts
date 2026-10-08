import { describe, expect, it } from 'vitest';
import { isGoogleFormsVisibleBrowserInteractionError } from './google-form-processor.js';

describe('Google Forms worker browser interaction handling', () => {
  it('recognizes upload failures that require keeping the visible browser open', () => {
    expect(
      isGoogleFormsVisibleBrowserInteractionError(
        new Error('GOOGLE_FORMS_UPLOAD_REQUIRES_BROWSER'),
      ),
    ).toBe(true);
    expect(
      isGoogleFormsVisibleBrowserInteractionError(
        new Error('GOOGLE_FORMS_UPLOAD_NOT_CONFIRMED'),
      ),
    ).toBe(true);
    expect(
      isGoogleFormsVisibleBrowserInteractionError(
        new Error('GOOGLE_FORMS_VALIDATION_FAILED'),
      ),
    ).toBe(true);
    expect(
      isGoogleFormsVisibleBrowserInteractionError(
        new Error('GOOGLE_FORMS_UNAPPROVED_MUTATION'),
      ),
    ).toBe(false);
  });
});
