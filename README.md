# Playwright Test for Visual Studio Code (alpha)

[![GitHub Actions](https://github.com/microsoft/playwright-vscode/actions/workflows/ci.yml/badge.svg?event=push)](https://github.com/microsoft/playwright-vscode/actions)
[![Visual Studio Marketplace](https://img.shields.io/visual-studio-marketplace/v/ms-playwright.playwright)](https://marketplace.visualstudio.com/items?itemName=ms-playwright.playwright)
[![Join Slack](https://img.shields.io/badge/join-slack-infomational)](https://aka.ms/playwright-slack)

This extension integrates [Playwright Test] with Visual Studio Code by using the [VSCode Testing API](https://code.visualstudio.com/api/extension-guides/testing).

<img width="715" alt="example_test_2" src="https://user-images.githubusercontent.com/883973/152095827-d04d7737-57b3-4b02-acc7-5a213ad4b637.png">

## Requirements

- [Playwright Test](https://playwright.dev) version 1.19+

## Usage

The extension automatically detects if you have [Playwright Test] installed and loads the [Playwright Test] projects into Visual Studio Code. By default it will select the first project as a run profile and inside the test explorer you can change this behavior to run a single test in multiple or different browsers.

### Run tests with a single click

You can use Tests sidebar to run a test or a group of tests with a single cick.

![run_tests](https://user-images.githubusercontent.com/883973/152095110-46667a83-1f56-4964-8e99-094b880b70a0.gif)

### Follow the execution line

While tests are running, execution line is highlighted, once the line has completed, step time is rendered as an editor decoration.

![execution_line](https://user-images.githubusercontent.com/883973/152095192-b85fb222-051a-40b2-8a6e-899d43d383c0.gif)

### Debug step-by-step, explore selectors

Right click and start breakpoint debugging. Set a breakpoint, hover over a value. When your cursor is on some Playwright action or a locator, corresponding element (or elements) are highlighted in the browser.

![step_explore](https://user-images.githubusercontent.com/883973/152095220-b68a2a3c-8395-4252-9be8-5c6adf35eddf.gif)

### Seelctors playground

You can edit text to fine-tune selectors while on a breakint. A selector playgroung on every line of your test script!

![tune_selectors](https://user-images.githubusercontent.com/883973/152095248-7dda7d77-b8ee-42ab-8902-9cf462d1f334.gif)
