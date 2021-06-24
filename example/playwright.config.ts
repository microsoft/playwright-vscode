// playwright.config.ts
import { PlaywrightTestConfig } from '@playwright/test';

const config: PlaywrightTestConfig = {
  projects: [
    {
      name: 'Chromium',
      use: {
        // Configure the browser to use.
        browserName: 'chromium',
        // Any Chromium-specific options.
        viewport: { width: 600, height: 800 },
      },
    },
    {
      name: 'Firefox',
      use: { browserName: 'firefox' },
    },
    {
      name: 'WebKit',
      use: { browserName: 'webkit' },
    },
  ],
};
export default config;