# Towards One Browser
**How Browser Server propels Playwright into the near future**

Currently, Playwright's VS Code extension, MCP Server and Terminal test runner each spawn their own browsers.
Because they don't interoperate, the following scenarios do not work:

1. Copilot can investigate why a test failed using the Playwright MCP tools.
1. The "Pick Locator" button in VS Code can be used on a page opened by Copilot.
1. After clicking on "Record at Cursor", I can ask Copilot to execute a test case, and it's recorded.
1. _(most importantly)_ My desktop isn't flooded with open browser windows, and all Playwright systems share one window.
1. MORE, this needs MORE

Potential scenarios, to be discussed:
1. Start a browser via Playwright MCP in VS Code; close VS Code; continue talking to the browser from Claude Code or Claude Desktop.

> While we primarily care about these VS Code scenarios, we should keep other development environments in mind, like Copilot Agent or Claude Code.

We can make the scenarios work by moving browser ownership from the individual Playwright processes (Extension, Terminal test runner, MCP server) into a dedicated process called "Browser Server".
This document outlines some of the open design questions.

## 1. Browser Server Lifecycle

### (a) Daemon

The Browser Server acts as a Daemon that manages its own lifecycle.
It's spun up by whatever system needs it, and then sticks around until:

1. there's no open connections AND
2. there's no open headful browsers

This design is agnostic of VS Code, and enables potential scenario #1.
It has the downside of introducing a new lifecycle, and the fact that browser windows stay open after VS Code is closed can be weird.

### (b) Dev Environment owns Browser Server

The VS Code Extension spins up a browser server, and when VS Code dies, the browsers die with it.

In non-VS Code dev environments, the browser server is spun up by the MCP server.

## 2. Versioning

### (a) Well-known port includes Playwright Version

For Playwright 1.53, the well-known port is: x + 1 * 1000 + 53
Means we need to find a range of ~100 free ports.
The same works for sockets.

### (b) Browser Server is version-agnostic

When a client connects, it sends its Playwright version and a pathname that can be used to require Playwright.
Means that we have only one browser server, but it can manage browsers from multiple versions.

### (c) We don't care

There's a single browser server on a single well-known port. If you have one dev environment open with one version of Playwright, you can't open a second dev environment on a different version.

## 3. Discovery

Depending on whether we need multiple browser servers, discovery becomes harder.
What happens if I have two instances of VS Code open a the same time? Do I want them to share a browser?

### (a) well-known port

Ports are easy to think about, but namespacing is hard.

### (b) file that contains a port

We put the port into the `.playwright/browser-server` file in the current workspace, this makes namespacing easy.

### (c) sockets

Same as above, but we create a socket instead of writing a port.

### (a) No explicit management UI

## 4. MCP Browser selection

If there's more than one open browser, the MCP needs to know which one to talk to.

### (a) MCP tools

On top of the existing `browser_close`, we add `browser_list` and `browser_switch`. `browser_switch(new)` starts a new browser, `browser_switch(4)` switches to the 4th browser in the `browser_list`.

### (b) Present as tabs

We already have support for multiple tabs, and all open browser contribute into that one list.

### (c) Dev Environment has explicit UI

We add a "browser list" UI to VS Code that allows selecting an "active" browser.

### (d) Force a single browser

There can only ever be a single open browser. When the test runner starts a browser, but there's browsers left from a previous run, we close them.

## 5. Management API

If we have an explicit "browser list" UI in VS Code, we need a management API for that.

### (a) /json/list

```sh
GET /json/list # get a list
DELETE /json/browser/1 # close a browser
...
```

This is familiar and easy to understand for 3rd parties, but doesn't support eventing so we'd need to poll the JSON list.

### (b) JSON RPC

Similar to the `DebugController`, we'd have a special kind of connection that uses our existing Dispatcher system for RPC and eventing.

This is harder to understand for 3rd parties, but more powerful than a Restful API.
