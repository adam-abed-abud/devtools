# Find and grep.nvim

Search with `rg`, add a second filter, and open the final results in Neovim quickfix.

This is for the workflow where a normal grep finds too much. Search broadly first, then filter the result list by another word in the file path or matching line.

## Features

- Search the current working directory with `ripgrep`.
- Filter results before they reach quickfix.
- Jump through matches with normal quickfix commands.
- Supports case-insensitive and case-sensitive search commands.
- Small Lua plugin with no UI dependency.

## Requirements

- Neovim 0.8+
- `ripgrep`

Install `ripgrep` on Ubuntu/Debian:

```bash
sudo apt update
sudo apt install ripgrep
```

Check that Neovim can see it:

```vim
:echo executable("rg")
```

It should print `1`.

## Install With LazyVim

Create this file:

```bash
nvim ~/.config/nvim/lua/plugins/find-and-grep.lua
```

Use this config:

```lua
return {
  {
    dir = "/home/adam/Desktop/devtools/find_and_grep_nvim",
    name = "find-and-grep.nvim",
    cmd = {
      "FindAndGrep",
      "FindAndGrepCase",
    },
    keys = {
      {
        "<leader>sg",
        "<cmd>FindAndGrep<cr>",
        desc = "Find and grep",
      },
    },
    config = function()
      require("find_and_grep").setup()
    end,
  },
}
```

Restart Neovim and run:

```vim
:Lazy sync
```

## Usage

Prompt for the search term and result filter:

```vim
:FindAndGrep
```

Search directly, then prompt for the result filter:

```vim
:FindAndGrep TODO
```

Run a case-sensitive search:

```vim
:FindAndGrepCase TODO
```

With the LazyVim keymap above:

```text
<leader>sg
```

In LazyVim, `<leader>` is usually `Space`, so press `Space s g`.

## Quickfix Navigation

Results open in quickfix. Useful commands:

```vim
:copen
:cnext
:cprev
:cclose
```

Press `Enter` on a quickfix item to jump to that match.

## Configuration

Default setup:

```lua
require("find_and_grep").setup()
```

Available options:

```lua
require("find_and_grep").setup({
  rg_command = "rg",
  max_results = 2000,
  open_quickfix = true,
})
```

If `rg` is installed somewhere outside Neovim's PATH, set the full path:

```lua
require("find_and_grep").setup({
  rg_command = "/usr/bin/rg",
})
```

## Troubleshooting

If you see this error:

```text
'rg' is not executable
```

Install `ripgrep`, then restart Neovim:

```bash
sudo apt install ripgrep
```

If LazyVim says the local plugin does not exist, check the path:

```bash
find ~/Desktop -type d -name find_and_grep_nvim
```

Use the exact printed path in the `dir = ...` field.
