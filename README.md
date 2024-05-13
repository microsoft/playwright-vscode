# Playwright Test for VS Code

This extension integrates Playwright into your VS Code workflow. Here is what it can do:

- [Playwright Test for VS Code](#playwright-test-for-vs-code)
    - [Requirements](#requirements)
  - [Install Playwright](#install-playwright)
  - [Run tests with a single click](#run-tests-with-a-single-click)
  - [Run multiple tests](#run-multiple-tests)
  - [Run tests in watch mode](#run-tests-in-watch-mode)
  - [Show browsers](#show-browsers)
  - [Show trace viewer](#show-trace-viewer)
  - [Pick locators](#pick-locators)
  - [Debug step-by-step, explore locators](#debug-step-by-step-explore-locators)
  - [Tune locators](#tune-locators)
  - [Record new tests](#record-new-tests)
  - [Record at cursor](#record-at-cursor)


![Playwright VS Code Extension](https://github.com/microsoft/playwright-vscode/assets/13063165/400a3f11-a1e8-4fe7-8ae6-b0460142de35)

### Requirements

This extension works with [Playwright] version v1.19+ or newer.

*If you are looking for the old extension that supported Playwright v1.14+, switch to v0.0.9 of this extension manually. Having said that, we highly recommend using the latest version of [Playwright]!*

## Install Playwright

If you don't have the Playwright NPM package installed in your project, or if you are starting with a new testing project, the "Install Playwright" action from the command panel will help you get started.

![Install Playwright](https://github.com/microsoft/playwright-vscode/assets/13063165/716281a0-4206-4f53-ad27-4a6c8fe1c323)

Pick the browsers you'd like to use by default, don't worry, you'll be able to change them later to add or configure the browsers used. You can also choose to add a GitHub Action so that you can easily run tests on Continuous Integration on every pull request or push.

![Choose browsers](https://github.com/microsoft/playwright-vscode/assets/13063165/138a65cb-96f1-41bc-8f3d-0aaff7835920)

The extension automatically detects if you have [Playwright] installed and loads the browsers, known as [Playwright] projects, into Visual Studio Code. By default it will select the first project as a run profile. Inside the test explorer in VS Code you can change this behavior to run a single test in multiple or different browsers.

![select project](https://github.com/microsoft/playwright-vscode/assets/13063165/414f375d-865f-4882-9ca0-070b4a76ce50)

## Run tests with a single click

Click the green triangle next to the test you want to run. You can also run the test from the testing sidebar by clicking the grey triangle next to the test name.

![run-tests](https://github.com/microsoft/playwright-vscode/assets/13063165/08eff858-b2ce-4a8d-8eb3-97feba478e68)

## Run multiple tests

You can use the Testing sidebar to run a single test or a group of tests with a single click. While tests are running, the execution line is highlighted. Once the line has completed, the duration of each step of the test is shown.

![run-multiple-tests](https://github.com/microsoft/playwright-vscode/assets/13063165/542fb6c4-15ee-4f54-b542-215569c83fbf)

## Run tests in watch mode

Click the "eye" icon to run tests in watch mode. This will re-run the watched tests when you save your changes.

![watch-mode](https://github.com/microsoft/playwright-vscode/assets/13063165/fdfb3348-23b2-4127-b4c1-3103dbde7d8a)

## Show browsers

Check the "show browsers" checkbox to run tests with the browser open so that you can visually see what is happening while your test is running. Click on "close all browsers" to close the browsers.

![show-browser](https://github.com/microsoft/playwright-vscode/assets/13063165/3e1ab5bb-8ed2-4032-b6ef-81fc4a38bf8f)

## Show trace viewer

Check the "show trace viewer" checkbox to see a full trace of your test.

![trace-viewer](https://github.com/microsoft/playwright-vscode/assets/13063165/959cb45c-7104-4607-b465-bf74099142c5)

## Pick locators

Click the "pick locator" button and hover over the browser to see the locators available. Clicking an element will store it in the locators box in VS Code. Pressing enter will save it to the clip board so you can easily paste it into your code or press the escape key to cancel.

![pick-locator](https://github.com/microsoft/playwright-vscode/assets/13063165/3bcb9d63-3d78-4e1a-a176-79cb12b39202)

## Debug step-by-step, explore locators

Right click and start breakpoint debugging. Set a breakpoint and hover over a value. When your cursor is on some Playwright action or a locator, the corresponding element (or elements) are highlighted in the browser.

![debug](https://github.com/microsoft/playwright-vscode/assets/13063165/7db9e6d4-f1b3-4794-9f61-270f78e930d8)

## Tune locators

You can edit the source code to fine-tune locators while on a breakpoint. Test out different locators and see them highlighted in the browser.

![tune-locators](https://github.com/microsoft/playwright-vscode/assets/13063165/00d7cd44-e9b0-472d-9f1f-f8882802d73a)

## Record new tests

Record new tests by clicking on the "record tests" button in the testing sidebar. This will open a browser window where you can navigate to a URL and perform actions on the page which will be recorded to a new test file in VS Code.

![record-test](https://github.com/microsoft/playwright-vscode/assets/13063165/841dbc65-35d7-40eb-8df2-5906b7aad4c6)

## Record at cursor

This generates actions into the existing test at the current cursor position. You can run the test, position the cursor at the end of the test and continue generating the test.

[Playwright]: https://playwright.dev "Playwright"
