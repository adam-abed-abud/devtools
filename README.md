# Devtools

A collection of small developer tools for editor workflows, search, navigation, and codebase maintenance.

## Projects

### Find and grep

Path: [`find_and_grep/`](find_and_grep/)

A VS Code extension for workspace find and replace with an extra result-filter step. It lets you search a folder or workspace, filter the found result list by path or preview text, then open or replace only the filtered matches.

Key features:

- VS Code sidebar search view.
- Native quick-search fallback.
- Match-case and whole-word filtering for found results.
- Replace only filtered matches.
- Uses `ripgrep` when available, with a built-in JavaScript fallback.

## Repository Layout

```text
.
├── find_and_grep/     # VS Code extension
├── README.md          # Repository overview
└── .gitignore
```

