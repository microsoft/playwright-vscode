# Playwright for Visual Studio Code

This extension integrates [Playwright Test] with Visual Studio Code by using the [Testing API](https://code.visualstudio.com/api/extension-guides/testing).

![Example test](./images/example-test.png)

## Usage

The extension automatically detects if you have [Playwright Test] installed and loads the [Playwright Test] projects into Visual Studio Code. By default it will select the first project and by right clicking on the play icon next to a test you can run a test in a specific browser (or project).

All tests of the project are shown inside the Test Explorer.

![Test Explorer](./images/test-explorer.png)

When running a test via the play icon, it will run on the selected profiles. You can change them via the `Select Default Profile` dropdown.

![Select default project](./images/select-default-project.png)

[Playwright Test]: https://playwright.dev/docs/intro/#first-test