# Playwright Test for VS Code

This extension integrates Playwright Test into your VSCode workflow. Here is what it can do:

- [Install Playwright Test](#install-playwright-test)
- [Run tests with a single click](#run-tests-with-a-single-click)
- [Follow the execution line](#follow-the-execution-line)
- [Debug step-by-step, explore selectors](#debug-step-by-step-explore-selectors)
- [Record new tests](#record-new-tests)
- [Tune selectors](#tune-selectors)

<br></br>

<img width="715" alt="example_test_2" src="https://user-images.githubusercontent.com/883973/152095827-d04d7737-57b3-4b02-acc7-5a213ad4b637.png">

<br></br>

### Requirements

This extension works with [Playwright Test] version v1.19+ or newer.


*If you are looking for the old extension that supported Playwright v1.14+, switch to v0.0.9 of this extension manually. Having said that, we highly recommend using the latest version of [Playwright Test]!*

<br></br>

## Install Playwright Test

If you don't have the Playwright Test NPM package installed in your project, or if you are starting with a new testing project, "Install Playwright" action will help you get started.

<img width="446" alt="Install Playwright" src="https://user-images.githubusercontent.com/883973/153693073-a83fc6e6-a17a-4011-b11e-2423f75ce584.png">

Pick the browsers you'd like to use by default, don't worry, you'll be able to change them later to add or configure the browsers used.

<img width="579" alt="Choose browsers" src="https://user-images.githubusercontent.com/883973/153693126-258646eb-0d4c-41eb-8c4a-7ac248384078.png">


The extension automatically detects if you have [Playwright Test] installed and loads the [Playwright Test] projects into Visual Studio Code. By default it will select the first project as a run profile and inside the test explorer you can change this behavior to run a single test in multiple or different browsers.

<br></br>

## Run tests with a single click

You can use Tests sidebar to run a test or a group of tests with a single click.

![run_tests](https://user-images.githubusercontent.com/883973/152095110-46667a83-1f56-4964-8e99-094b880b70a0.gif)

<br></br>

## Follow the execution line

While tests are running, execution line is highlighted, once the line has completed, step time is rendered as an editor decoration.

![execution_line](https://user-images.githubusercontent.com/883973/152095192-b85fb222-051a-40b2-8a6e-899d43d383c0.gif)

<br></br>

## Debug step-by-step, explore selectors

Right click and start breakpoint debugging. Set a breakpoint, hover over a value. When your cursor is on some Playwright action or a locator, corresponding element (or elements) are highlighted in the browser.

![step_explore](https://user-images.githubusercontent.com/883973/152095220-b68a2a3c-8395-4252-9be8-5c6adf35eddf.gif)

<br></br>

## Record new tests

Record new tests via performing the test actions in the browser.

![recording](https://user-images.githubusercontent.com/883973/153694515-f25fdd12-7a7c-4fec-9695-36b19b1d6a6b.gif)

<br></br>

## Tune selectors

You can edit test source code to fine-tune selectors while on a breakpoint. A selector playground on every line of your test script!

![tune_selectors](https://user-images.githubusercontent.com/883973/152095248-7dda7d77-b8ee-42ab-8902-9cf462d1f334.gif)


[Playwright Test]: https://playwright.dev "Playwright Test"
