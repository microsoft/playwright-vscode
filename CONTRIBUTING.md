# Contributing
## Releasing

1. Briefly review changes since last release with the team and get approval. Double-check tests are healthy.
2. Run `npm version patch --no-git-tag-version` and post a PR with it. Example: https://github.com/microsoft/playwright-vscode/pull/695
3. Get it approved + merged.
4. Draft a new release under https://github.com/microsoft/playwright-vscode/releases, use the merged commit as target.
5. Have somebody review the release notes, then hit "Release". An Azure Pipeline will release the extension to the marketplace.
