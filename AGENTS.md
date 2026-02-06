# Playwright VS Code Extension

## Running the Extension in Browser

Always verify your code changes by running the extension in a browser using VS Code's `serve-web` command.

Run `npm run serve-web` to start VS Code with the locally built extension installed.
It prints a URL you can open in a browser. By default, it'll have the examples/todomvc folder pre-opened.
After making changes to the extension, kill the serve-web process and run it again to reload.
If it behaves weirdly, check if ../playwright is on a stable branch.

Tips for navigating VS Code UI:
- `Ctrl+P` to open files by name
- `Ctrl+Shift+P` to open command palette
- The text editor does not represent well in snapshots, so don't be surprised if you can't see the opened editor's code or see the green triangle in the editor gutter.
