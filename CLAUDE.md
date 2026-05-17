## Commit Convention

Semantic commit messages: `label(scope): description`

Labels: `fix`, `feat`, `chore`, `docs`, `test`, `devops`

```bash
git checkout -b fix-12345
# ... make changes ...
git add <changed-files>
git commit -m "$(cat <<'EOF'
fix: ask for 127.0.0.1 host when launching test server

Fixes: https://github.com/microsoft/playwright-vscode/issues/12345
EOF
)"
git push origin fix-12345
gh pr create --repo microsoft/playwright-vscdoe --head username:fix-12345 \
  --title "fix: ask for 127.0.0.1 host when launching test server" \
  --body "$(cat <<'EOF'
## Summary
- <describe the change very! briefly>

Fixes https://github.com/microsoft/playwright/issues/12345
EOF
)"
```

Never add Co-Authored-By agents in commit message.
Never add "Generated with" in commit message.
Never add test plan to PR description. Keep PR description short — a few bullet points at most.
Branch naming for issue fixes: `fix-<issue-number>`

**Never `git push` without an explicit instruction to push.** Applies even when a PR is already open for the branch — additional commits are immediately visible to reviewers. Commit locally, report what was committed, and wait. Only push when the user's message contains "push", "upload", "create PR", "ship it", or equivalent.
