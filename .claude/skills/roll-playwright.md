---
name: roll-playwright
description: Roll @playwright/test to the latest next version, build, test, and push a PR branch
user_invocable: true
---

# Roll Playwright Dependency

Follow these steps in order. Stop and report to the user if any step fails.

## 1. Get the latest version

Run `npm info @playwright/test@next version` to get the latest available next version. Save this version string for later.

## 2. Update package.json

Update the `@playwright/test` version in `devDependencies` in `package.json` to the version from step 1.

## 3. Install dependencies

Run `npm i` to update `package-lock.json`.

## 4. Build

Run `npm run build`. If this fails, stop and report the error.

## 5. Test

Run `npm run test`. If this fails, stop and report the error.

## 6. Create branch, commit, and push

- Create a new branch named `roll-pwt-<version>` (e.g. `roll-pwt-1.58.2-beta-1770322573000`)
- Stage `package.json` and `package-lock.json`
- Commit with message: `chore: roll playwright to <version>`
- Do NOT add Co-Authored-By to the commit message
- Push the branch to origin
