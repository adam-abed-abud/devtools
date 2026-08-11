# Find and grep.nvim

Neovim search powered by `rg`, with a second filter before results go to quickfix.

## Requirements

- Neovim 0.8+
- `ripgrep`

## Install

Use your plugin manager and point it at this local directory or repository.

Example setup:

```lua
require("find_and_grep").setup()
```

## Usage

```vim
:FindAndGrep
:FindAndGrep TODO
:FindAndGrepCase TODO
```

Results open in quickfix.
