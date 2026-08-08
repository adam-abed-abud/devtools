if vim.g.loaded_find_and_grep == 1 then
  return
end

vim.g.loaded_find_and_grep = 1

require("find_and_grep").setup()
