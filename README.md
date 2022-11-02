# Playwright Test for VS Code

This extension integrates Playwright into your VS Code workflow. Here is what it can do:

- [Playwright Test for VS Code](#playwright-test-for-vs-code)
    - [Requirements](#requirements)
  - [Install Playwright](#install-playwright)
  - [Run tests with a single click](#run-tests-with-a-single-click)
  - [Run Multiple Tests](#run-multiple-tests)
  - [Show browsers](#show-browsers)
  - [Pick locators](#pick-locators)
  - [Debug step-by-step, explore locators](#debug-step-by-step-explore-locators)
  - [Tune locators](#tune-locators)
  - [Record new tests](#record-new-tests)
  - [Record at cursor](#record-at-cursor)


<img width="1268" alt="example test in vs code" src="https://user-images.githubusercontent.com/13063165/194532498-b7f88d69-65a3-49f4-b701-5ef7134bc551.png">

### Requirements

This extension works with [Playwright] version v1.19+ or newer.


*If you are looking for the old extension that supported Playwright v1.14+, switch to v0.0.9 of this extension manually. Having said that, we highly recommend using the latest version of [Playwright Test]!*



## Install Playwright

If you don't have the Playwright NPM package installed in your project, or if you are starting with a new testing project, the "Install Playwright" action from the command panel will help you get started.


<img width="1189" alt="Install Playwright" src="https://user-images.githubusercontent.com/13063165/193314391-6c1df069-857f-4fff-b4fd-5a228bd2fb5d.png"/>

Pick the browsers you'd like to use by default, don't worry, you'll be able to change them later to add or configure the browsers used. You can also choose to add a GitHub Action so that you can easily run tests on Continuous Integration on every pull request or push.

<img width="1189" alt="Choose browsers" src="https://user-images.githubusercontent.com/13063165/193314396-a32e6344-89ad-429e-a886-5367917602f3.png" />



The extension automatically detects if you have [Playwright] installed and loads the browsers, known as [Playwright] projects, into Visual Studio Code. By default it will select the first project as a run profile. Inside the test explorer in VS Code you can change this behavior to run a single test in multiple or different browsers.


![select-profile](https://user-images.githubusercontent.com/13063165/194548273-c7034777-e510-49af-9834-99e9eb528a45.gif)



## Run tests with a single click

Click the green triangle next to the test you want to run. You can also run the test from the testing sidebar by clicking the grey triangle next to the test name.


![runtest](https://user-images.githubusercontent.com/13063165/194504291-c797fab1-7ad2-47dc-8d6f-371ce22d01d7.gif)


## Run Multiple Tests

You can use the Testing sidebar to run a single test or a group of tests with a single click. While tests are running, the execution line is highlighted. Once the line has completed, the duration of each step of the test is shown.


![runtests](https://user-images.githubusercontent.com/13063165/193856188-4103cbb6-9115-42eb-aed3-d06ffc78c2cc.gif)

<br/>

## Show browsers

Check the "show browsers" checkbox to run tests with the browser open so that you can visually see what is happening while your test is running. Click on "close all browsers" to close the browsers.


![show-browser](https://user-images.githubusercontent.com/13063165/194509233-b2b708cb-e7c4-48ec-b9ea-80587371bbbd.gif)

<br/>

## Pick locators

Click the "pick locator" button and hover over the browser to see the locators available. Clicking an element will store it in the locators box in VS Code. Pressing enter will save it to the clip board so you can easily paste it into your code or press the escape key to cancel.

![pick-locator](https://user-images.githubusercontent.com/13063165/194384763-96263c13-8435-425f-ba4b-6029a7c67f3d.gif)

<br/>

## Debug step-by-step, explore locators

Right click and start breakpoint debugging. Set a breakpoint and hover over a value. When your cursor is on some Playwright action or a locator, the corresponding element (or elements) are highlighted in the browser.

![debugging](https://user-images.githubusercontent.com/13063165/194526375-9d2b339e-e108-45d5-a53b-e884661c1954.gif)

<br/>

## Tune locators

You can edit the source code to fine-tune locators while on a breakpoint. Test out different locators and see them highlighted in the browser.


![edit-locators](https://user-images.githubusercontent.com/13063165/194527588-5d7d1e7f-6eac-4050-8a87-ac009c221f65.gif)

<br/>

## Record new tests

Record new tests by clicking on the "record tests" button in the testing sidebar. This will open a browser window where you can navigate to a URL and perform actions on the page which will be recorded to a new test file in VS Code.

![record-new2](https://user-images.githubusercontent.com/13063165/194530684-2f8b89b4-8973-4ae7-a327-27ec51fc6d51.gif)

<br>

## Record at cursor

This generates actions into the existing test at the current cursor position. You can run the test, position the cursor at the end of the test and continue generating the test.


[Playwright]: https://playwright.dev "Playwright"
