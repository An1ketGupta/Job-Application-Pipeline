import { describe, expect, it } from 'vitest';
import { loadConfig } from './index.js';

describe('Carrerlift MCP configuration', () => {
  it('accepts keyless MCP configuration and defaults to one page', () => {
    expect(
      loadConfig({
        CAREERLIFT_MCP_URL: 'https://www.carrerlift.in/api/mcp',
        CAREERLIFT_API_URL: '',
        CAREERLIFT_MCP_TYPE: '',
        CAREERLIFT_MCP_MAX_PAGES: '',
      }),
    ).toMatchObject({
      CAREERLIFT_MCP_URL: 'https://www.carrerlift.in/api/mcp',
      CAREERLIFT_MCP_MAX_PAGES: 1,
    });
    expect(
      loadConfig({ CAREERLIFT_MCP_URL: '' }).CAREERLIFT_MCP_URL,
    ).toBeUndefined();
  });

  it('validates search filters and the provider page limit', () => {
    expect(
      loadConfig({
        CAREERLIFT_MCP_TYPE: 'Internship',
        CAREERLIFT_MCP_MAX_PAGES: '3',
      }),
    ).toMatchObject({
      CAREERLIFT_MCP_TYPE: 'Internship',
      CAREERLIFT_MCP_MAX_PAGES: 3,
    });
    expect(() => loadConfig({ CAREERLIFT_MCP_MAX_PAGES: '21' })).toThrow();
    expect(() => loadConfig({ CAREERLIFT_MCP_TYPE: 'invalid' })).toThrow();
  });
});
