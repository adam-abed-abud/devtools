local M = {}

local defaults = {
  rg_command = "rg",
  max_results = 2000,
  open_quickfix = true,
}

local config = vim.deepcopy(defaults)

local function trim(value)
  return (value or ""):gsub("^%s+", ""):gsub("%s+$", "")
end

local function escape_pattern(value)
  return value:gsub("([^%w])", "%%%1")
end

local function build_filter(filter, opts)
  filter = trim(filter)
  if filter == "" then
    return function()
      return true
    end
  end

  local needle = opts.match_case and filter or filter:lower()
  local pattern = opts.whole_word and ("%f[%w]" .. escape_pattern(needle) .. "%f[%W]") or escape_pattern(needle)

  return function(item)
    local haystack = item.filename .. " " .. item.text
    if not opts.match_case then
      haystack = haystack:lower()
    end
    return haystack:find(pattern) ~= nil
  end
end

local function rg_args(query, opts)
  local args = {
    config.rg_command,
    "--vimgrep",
    "--no-heading",
    "--color=never",
  }

  if opts.fixed_strings then
    table.insert(args, "--fixed-strings")
  end

  if not opts.match_case then
    table.insert(args, "--ignore-case")
  end

  if opts.whole_word then
    table.insert(args, "--word-regexp")
  end

  table.insert(args, query)
  return args
end

local function parse_vimgrep_line(line)
  local filename, lnum, col, text = line:match("^(.-):(%d+):(%d+):(.*)$")
  if not filename then
    return nil
  end

  return {
    filename = filename,
    lnum = tonumber(lnum),
    col = tonumber(col),
    text = text,
  }
end

local function system_lines(args)
  if vim.fn.executable(args[1]) ~= 1 then
    vim.notify(
      "Find and grep: '" .. args[1] .. "' is not executable. Install ripgrep or set rg_command in setup().",
      vim.log.levels.ERROR
    )
    return nil
  end

  local output = vim.fn.systemlist(args)
  local code = vim.v.shell_error
  if code > 1 then
    vim.notify(table.concat(output, "\n"), vim.log.levels.ERROR)
    return nil
  end
  return output
end

function M.search(opts)
  opts = vim.tbl_extend("force", {
    query = nil,
    filter = nil,
    match_case = false,
    whole_word = false,
    fixed_strings = true,
    filter_match_case = false,
    filter_whole_word = false,
  }, opts or {})

  local query = opts.query or vim.fn.input("Find: ")
  query = trim(query)
  if query == "" then
    return
  end

  local filter = opts.filter
  if filter == nil then
    filter = vim.fn.input("Filter results: ")
  end

  local lines = system_lines(rg_args(query, opts))
  if not lines then
    return
  end

  local keep = build_filter(filter, {
    match_case = opts.filter_match_case,
    whole_word = opts.filter_whole_word,
  })
  local items = {}

  for _, line in ipairs(lines) do
    local item = parse_vimgrep_line(line)
    if item and keep(item) then
      table.insert(items, item)
      if #items >= config.max_results then
        break
      end
    end
  end

  vim.fn.setqflist({}, " ", {
    title = "Find and grep: " .. query,
    items = items,
  })

  if config.open_quickfix then
    vim.cmd("copen")
  end

  vim.notify(("Find and grep: %d result%s"):format(#items, #items == 1 and "" or "s"))
end

function M.setup(opts)
  config = vim.tbl_extend("force", defaults, opts or {})

  vim.api.nvim_create_user_command("FindAndGrep", function(command)
    M.search({
      query = command.args ~= "" and command.args or nil,
    })
  end, {
    nargs = "?",
    desc = "Search with rg, filter results, and populate quickfix",
  })

  vim.api.nvim_create_user_command("FindAndGrepCase", function(command)
    M.search({
      query = command.args ~= "" and command.args or nil,
      match_case = true,
    })
  end, {
    nargs = "?",
    desc = "Case-sensitive Find and grep search",
  })
end

return M
