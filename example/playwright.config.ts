// playwright.config.ts
import { PlaywrightTestConfig, devices } from '@playwright/test';

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
      name: 'WebKit with iPhone 12 Pro Max',
      use: { browserName: 'webkit', ...devices["iPhone 12 Pro Max"] },
    },
  ],
};
export default config;