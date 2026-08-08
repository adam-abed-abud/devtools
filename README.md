# Search Sieve

A VS Code extension for workspace find and replace with an extra filter for narrowing the result list after the search runs.

## Features

- Search across a selected folder or open workspace.
- Filter found results by path or preview text.
- Use match-case and whole-word options for the result filter.
- Replace only the currently filtered results.
- Use the styled sidebar view or the native quick-search fallback.
- Prefer `ripgrep` when available, with a built-in JavaScript fallback when it is not.

## Run Locally

1. Open this folder in VS Code.
2. Press `F5` to launch an Extension Development Host.
3. Open Explorer and use the `Filtered Search` view in the sidebar.
4. If the window has no workspace folder, click `...` and choose the folder to search.

You can also run `Filtered Find: Quick Search` from the command palette for the native fallback flow. It asks for the result filter and whether that filter should use match-case and/or whole-word matching.

Default keybinding:

- Windows/Linux: `Ctrl+Alt+F`
- macOS: `Cmd+Alt+F`

## Project Status

This is an early local extension scaffold. Before Marketplace publishing, add screenshots, an icon, repository metadata, and a final publisher ID in `package.json`.

## Notes

VS Code extensions cannot add a custom field directly to the built-in Search sidebar. This extension provides a separate panel backed by `ripgrep` when available and a built-in JavaScript search fallback otherwise.

If VS Code fails to load webviews in the Extension Development Host, use `Filtered Find: Quick Search`. It uses native VS Code input boxes and quick picks, so it does not depend on the webview runtime.
