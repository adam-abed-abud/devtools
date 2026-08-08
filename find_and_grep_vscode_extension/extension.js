const vscode = require("vscode");
const cp = require("child_process");
const fs = require("fs/promises");
const path = require("path");
const util = require("util");

const execFile = util.promisify(cp.execFile);

let panel;
let activeWebview;
let lastResults = [];
let selectedRoot;
let lastSearchBackend = "ripgrep";

function activate(context) {
  const provider = new FilteredFindViewProvider();
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider("filteredFind.sidebar", provider),
    vscode.commands.registerCommand("filteredFind.open", () => {
      openPanel(context);
    }),
    vscode.commands.registerCommand("filteredFind.quickSearch", () => {
      quickSearch();
    })
  );
}

function deactivate() {}

class FilteredFindViewProvider {
  resolveWebviewView(webviewView) {
    const initialRoot = getSearchRoot();
    activeWebview = webviewView.webview;
    webviewView.webview.options = { enableScripts: true };
    webviewView.webview.html = getWebviewHtml(initialRoot ? initialRoot.fsPath : "");
    webviewView.webview.onDidReceiveMessage(handleWebviewMessage);
    webviewView.onDidDispose(() => {
      if (activeWebview === webviewView.webview) {
        activeWebview = undefined;
      }
    });
  }
}

function openPanel(context) {
  if (panel) {
    panel.reveal(vscode.ViewColumn.Beside);
    return;
  }

  panel = vscode.window.createWebviewPanel(
    "filteredFind",
    "Find and grep",
    vscode.ViewColumn.Beside,
    { enableScripts: true, retainContextWhenHidden: true }
  );

  const initialRoot = getSearchRoot();
  panel.webview.html = getWebviewHtml(initialRoot ? initialRoot.fsPath : "");
  activeWebview = panel.webview;
  const panelWebview = panel.webview;
  panel.onDidDispose(() => {
    if (activeWebview === panelWebview) {
      activeWebview = undefined;
    }
    panel = undefined;
    lastResults = [];
  });

  panel.webview.onDidReceiveMessage(handleWebviewMessage);
}

async function handleWebviewMessage(message) {
  try {
    if (message.type === "search") {
      await runSearch(message.options);
    }

    if (message.type === "openResult") {
      await openResult(message.id);
    }

    if (message.type === "replaceAll") {
      await replaceAll(message.options);
    }

    if (message.type === "chooseFolder") {
      await chooseSearchFolder();
    }
  } catch (error) {
    vscode.window.showErrorMessage(error instanceof Error ? error.message : String(error));
    post({ type: "error", message: error instanceof Error ? error.message : String(error) });
  }
}

async function runSearch(options) {
  const pattern = String(options.pattern || "");
  if (!pattern) {
    lastResults = [];
    post({ type: "results", results: [], total: 0 });
    return;
  }

  const searchRoot = getSearchRoot();
  if (!searchRoot) {
    post({
      type: "noWorkspace",
      message: "Choose a search folder before searching."
    });
    return;
  }

  const maxResults = Number(options.maxResults || 2000);

  post({ type: "searching" });

  lastResults = await collectSearchResults(options, searchRoot, maxResults);
  post({ type: "results", results: lastResults, total: lastResults.length, backend: lastSearchBackend });
}

async function collectSearchResults(options, searchRoot, maxResults) {
  const results = [];

  const args = buildRipgrepArgs(options, maxResults);
  let stdout = "";

  try {
    const output = await execFile("rg", args, {
      cwd: searchRoot.fsPath,
      maxBuffer: 50 * 1024 * 1024
    });
    stdout = output.stdout;
  } catch (error) {
    if (error && error.code === 1) {
      stdout = error.stdout || "";
    } else if (error && error.code === "ENOENT") {
      lastSearchBackend = "built-in";
      return collectSearchResultsWithNode(options, searchRoot, maxResults);
    } else {
      throw new Error((error && error.stderr) || (error && error.message) || String(error));
    }
  }

  lastSearchBackend = "ripgrep";

  for (const line of stdout.split(/\r?\n/)) {
    if (!line) {
      continue;
    }

    const event = JSON.parse(line);
    if (event.type !== "match") {
      continue;
    }

    const data = event.data;
    const relativePath = data.path.text;
    const lineText = data.lines.text.replace(/\r?\n$/, "");

    for (const submatch of data.submatches) {
      if (results.length >= maxResults) {
        break;
      }

      const absolutePath = path.resolve(searchRoot.fsPath, relativePath);
      results.push({
        id: results.length,
        uri: vscode.Uri.file(absolutePath).toString(),
        path: relativePath,
        line: data.line_number - 1,
        character: byteOffsetToUtf16(lineText, submatch.start),
        text: lineText.trim()
      });
    }
  }

  return results;
}

async function collectSearchResultsWithNode(options, searchRoot, maxResults) {
  const files = await listSearchableFiles(searchRoot.fsPath, options);
  const results = [];
  const matcherOptions = {
    ...options,
    isGlobal: true
  };

  for (const file of files) {
    if (results.length >= maxResults) {
      break;
    }

    let text;
    try {
      const buffer = await fs.readFile(file);
      if (buffer.includes(0)) {
        continue;
      }
      text = buffer.toString("utf8");
    } catch {
      continue;
    }

    const lineStarts = getLineStarts(text);
    const matcher = buildMatcher(matcherOptions);
    let match;

    while ((match = matcher.exec(text)) !== null) {
      const position = positionAtOffset(lineStarts, match.index);
      const lineText = lineAt(text, lineStarts, position.line);
      results.push({
        id: results.length,
        uri: vscode.Uri.file(file).toString(),
        path: path.relative(searchRoot.fsPath, file),
        line: position.line,
        character: position.character,
        text: lineText.trim()
      });

      if (results.length >= maxResults) {
        break;
      }

      if (match[0] === "") {
        matcher.lastIndex += 1;
      }
    }
  }

  return results;
}

async function listSearchableFiles(root, options) {
  const files = [];
  const stack = [root];
  const includePatterns = splitGlobs(options.include).map(globToRegExp);
  const excludePatterns = splitGlobs(options.exclude).map(globToRegExp);
  const ignoredDirs = new Set([".git", "node_modules", "dist", "build", "out", ".next", "coverage"]);

  while (stack.length) {
    const current = stack.pop();
    let entries;

    try {
      entries = await fs.readdir(current, { withFileTypes: true });
    } catch {
      continue;
    }

    for (const entry of entries) {
      const fullPath = path.join(current, entry.name);
      const relativePath = path.relative(root, fullPath);

      if (entry.isDirectory()) {
        if (!ignoredDirs.has(entry.name) && !matchesAny(relativePath, excludePatterns)) {
          stack.push(fullPath);
        }
        continue;
      }

      if (!entry.isFile()) {
        continue;
      }

      if (includePatterns.length && !matchesAny(relativePath, includePatterns)) {
        continue;
      }

      if (matchesAny(relativePath, excludePatterns)) {
        continue;
      }

      files.push(fullPath);
    }
  }

  return files;
}

async function quickSearch() {
  let searchRoot = getSearchRoot();
  if (!searchRoot) {
    await chooseSearchFolder();
    searchRoot = getSearchRoot();
  }

  if (!searchRoot) {
    return;
  }

  const pattern = await vscode.window.showInputBox({
    title: "Find and grep",
    prompt: "Find",
    ignoreFocusOut: true
  });

  if (!pattern) {
    return;
  }

  const filter = await vscode.window.showInputBox({
    title: "Find and grep",
    prompt: "Filter results",
    ignoreFocusOut: true
  });

  const filterOptions = await vscode.window.showQuickPick(
    [
      {
        label: "Default",
        description: "case-insensitive substring filter",
        filterMatchCase: false,
        filterWholeWord: false
      },
      {
        label: "Match Case",
        description: "case-sensitive substring filter",
        filterMatchCase: true,
        filterWholeWord: false
      },
      {
        label: "Whole Word",
        description: "case-insensitive whole-word filter",
        filterMatchCase: false,
        filterWholeWord: true
      },
      {
        label: "Match Case + Whole Word",
        description: "case-sensitive whole-word filter",
        filterMatchCase: true,
        filterWholeWord: true
      }
    ],
    {
      title: "Find and grep",
      placeHolder: "Filter matching options",
      ignoreFocusOut: true
    }
  );

  if (!filterOptions) {
    return;
  }

  const options = {
    pattern,
    replacement: "",
    include: "",
    exclude: "",
    matchCase: false,
    wholeWord: false,
    isRegex: false,
    maxResults: 2000
  };

  await vscode.window.withProgress(
    {
      location: vscode.ProgressLocation.Notification,
      title: "Find and grep: searching",
      cancellable: false
    },
    async () => {
      lastResults = await collectSearchResults(options, searchRoot, options.maxResults);
    }
  );

  const filtered = filterResults(lastResults, {
    text: filter || "",
    matchCase: filterOptions.filterMatchCase,
    wholeWord: filterOptions.filterWholeWord
  });
  if (!filtered.length) {
    vscode.window.showInformationMessage(`No results${lastResults.length ? " after filtering" : ""}.`);
    return;
  }

  const replaceItem = {
    label: "$(replace-all) Replace Filtered Results",
    description: `${filtered.length} result${filtered.length === 1 ? "" : "s"}`,
    alwaysShow: true,
    replace: true
  };

  const picked = await vscode.window.showQuickPick(
    [
      replaceItem,
      ...filtered.map((result) => ({
        label: `${result.path}:${result.line + 1}:${result.character + 1}`,
        description: result.text,
        result
      }))
    ],
    {
      title: "Find and grep Results",
      placeHolder: `${filtered.length} of ${lastResults.length} results (${lastSearchBackend})`,
      matchOnDescription: true,
      ignoreFocusOut: true
    }
  );

  if (!picked) {
    return;
  }

  if (picked.replace) {
    const replacement = await vscode.window.showInputBox({
      title: "Find and grep",
      prompt: "Replace filtered results with",
      ignoreFocusOut: true
    });

    if (replacement === undefined) {
      return;
    }

    await replaceAll({ ...options, replacement, onlyIds: filtered.map((result) => result.id) });
    return;
  }

  await openResult(picked.result.id);
}

function filterResults(results, filter) {
  const filterText = String(filter.text || "").trim();
  if (!filterText) {
    return results;
  }

  const matcher = buildTextFilter(filterText, {
    matchCase: Boolean(filter.matchCase),
    wholeWord: Boolean(filter.wholeWord)
  });

  return results.filter((result) => {
    return matcher(result.path) || matcher(result.text);
  });
}

function buildTextFilter(filterText, options) {
  if (!options.wholeWord) {
    const needle = options.matchCase ? filterText : filterText.toLocaleLowerCase();
    return (value) => {
      const haystack = options.matchCase ? value : value.toLocaleLowerCase();
      return haystack.includes(needle);
    };
  }

  const flags = options.matchCase ? "" : "i";
  const regex = new RegExp(`\\b${escapeRegExp(filterText)}\\b`, flags);
  return (value) => regex.test(value);
}

async function chooseSearchFolder() {
  const folders = await vscode.window.showOpenDialog({
    canSelectFiles: false,
    canSelectFolders: true,
    canSelectMany: false,
    openLabel: "Use Folder"
  });

  if (!folders || !folders.length) {
    return;
  }

  selectedRoot = folders[0];
  post({ type: "rootChanged", path: selectedRoot.fsPath });
}

function getSearchRoot() {
  if (selectedRoot) {
    return selectedRoot;
  }

  const workspaceFolder = vscode.workspace.workspaceFolders && vscode.workspace.workspaceFolders[0];
  return workspaceFolder ? workspaceFolder.uri : undefined;
}

async function openResult(id) {
  const item = lastResults.find((result) => result.id === id);
  if (!item) {
    return;
  }

  const uri = vscode.Uri.parse(item.uri);
  const document = await vscode.workspace.openTextDocument(uri);
  const editor = await vscode.window.showTextDocument(document, vscode.ViewColumn.One);
  const position = new vscode.Position(item.line, item.character);
  editor.selection = new vscode.Selection(position, position);
  editor.revealRange(new vscode.Range(position, position), vscode.TextEditorRevealType.InCenter);
}

async function replaceAll(options) {
  const replacement = String(options.replacement || "");
  const selectedIds = Array.isArray(options.onlyIds) ? new Set(options.onlyIds) : undefined;
  const replaceResults = selectedIds ? lastResults.filter((result) => selectedIds.has(result.id)) : lastResults;

  if (!replaceResults.length) {
    vscode.window.showInformationMessage("Run a search before replacing.");
    return;
  }

  const confirmed = await vscode.window.showWarningMessage(
    `Replace ${replaceResults.length} result${replaceResults.length === 1 ? "" : "s"}?`,
    { modal: true },
    "Replace All"
  );

  if (confirmed !== "Replace All") {
    return;
  }

  const edit = new vscode.WorkspaceEdit();
  const grouped = new Map();

  for (const result of replaceResults) {
    const list = grouped.get(result.uri) || [];
    list.push(result);
    grouped.set(result.uri, list);
  }

  for (const [uriString, results] of grouped) {
    const uri = vscode.Uri.parse(uriString);
    const document = await vscode.workspace.openTextDocument(uri);
    const text = document.getText();
    const matcher = buildMatcher(options);
    let match;

    while ((match = matcher.exec(text)) !== null) {
      const start = document.positionAt(match.index);
      const end = document.positionAt(match.index + match[0].length);
      const shouldReplace = results.some((result) => result.line === start.line && result.character === start.character);
      if (shouldReplace) {
        edit.replace(uri, new vscode.Range(start, end), replacementForMatch(replacement, match, Boolean(options.isRegex)));
      }
      if (match[0] === "") {
        matcher.lastIndex += 1;
      }
    }
  }

  const applied = await vscode.workspace.applyEdit(edit);
  if (applied) {
    await vscode.workspace.saveAll(false);
    vscode.window.showInformationMessage(`Replaced ${replaceResults.length} result${replaceResults.length === 1 ? "" : "s"}.`);
    await runSearch(options);
  }
}

function buildMatcher(options) {
  const flags = options.matchCase ? "g" : "gi";
  let source = String(options.pattern || "");

  if (!options.isRegex) {
    source = escapeRegExp(source);
  }

  if (options.wholeWord) {
    source = `\\b(?:${source})\\b`;
  }

  return new RegExp(source, flags);
}

function buildRipgrepArgs(options, maxResults) {
  const args = [
    "--json",
    "--line-number",
    "--column",
    "--with-filename",
    "--max-count",
    String(maxResults)
  ];

  if (!options.isRegex) {
    args.push("--fixed-strings");
  }

  if (!options.matchCase) {
    args.push("--ignore-case");
  }

  if (options.wholeWord) {
    args.push("--word-regexp");
  }

  for (const include of splitGlobs(options.include)) {
    args.push("--glob", include);
  }

  for (const exclude of splitGlobs(options.exclude)) {
    args.push("--glob", `!${exclude}`);
  }

  args.push(String(options.pattern || ""));
  return args;
}

function splitGlobs(value) {
  return String(value || "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

function globToRegExp(glob) {
  const normalized = glob.replace(/\\/g, "/");
  const escaped = normalized.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  const source = escaped.replace(/\*\*/g, "\0").replace(/\*/g, "[^/]*").replace(/\0/g, ".*");
  return new RegExp(`^${source}$`);
}

function matchesAny(relativePath, patterns) {
  const normalized = relativePath.replace(/\\/g, "/");
  return patterns.some((pattern) => pattern.test(normalized));
}

function getLineStarts(text) {
  const starts = [0];
  for (let index = 0; index < text.length; index += 1) {
    if (text[index] === "\n") {
      starts.push(index + 1);
    }
  }
  return starts;
}

function positionAtOffset(lineStarts, offset) {
  let low = 0;
  let high = lineStarts.length - 1;

  while (low <= high) {
    const middle = Math.floor((low + high) / 2);
    if (lineStarts[middle] <= offset) {
      low = middle + 1;
    } else {
      high = middle - 1;
    }
  }

  const line = Math.max(0, high);
  return {
    line,
    character: offset - lineStarts[line]
  };
}

function lineAt(text, lineStarts, line) {
  const start = lineStarts[line];
  const nextStart = lineStarts[line + 1] || text.length;
  return text.slice(start, nextStart).replace(/\r?\n$/, "");
}

function byteOffsetToUtf16(value, byteOffset) {
  return Buffer.from(value).subarray(0, byteOffset).toString("utf8").length;
}

function replacementForMatch(replacement, match, isRegex) {
  if (!isRegex) {
    return replacement;
  }

  return replacement.replace(/\$(\d+)/g, (_, index) => match[Number(index)] || "");
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function post(message) {
  if (activeWebview) {
    activeWebview.postMessage(message);
  }
  if (panel && panel.webview !== activeWebview) {
    panel.webview.postMessage(message);
  }
}

function getWebviewHtml(initialRoot) {
  const nonce = String(Date.now());
  const serializedInitialRoot = JSON.stringify(initialRoot);
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <style>
    :root {
      --border: var(--vscode-sideBarSectionHeader-border, var(--vscode-panel-border));
      --muted: var(--vscode-descriptionForeground);
      --row-hover: var(--vscode-list-hoverBackground);
      --row-active: var(--vscode-list-activeSelectionBackground);
    }
    body {
      margin: 0;
      padding: 0;
      color: var(--vscode-foreground);
      background: var(--vscode-sideBar-background, var(--vscode-editor-background));
      font-family: var(--vscode-font-family);
      font-size: var(--vscode-font-size);
    }
    .stack {
      display: grid;
      gap: 0;
    }
    .toolbar {
      display: flex;
      align-items: center;
      justify-content: space-between;
      min-height: 30px;
      padding: 0 8px;
      border-bottom: 1px solid var(--border);
      background: var(--vscode-sideBarSectionHeader-background);
      font-weight: 600;
      text-transform: uppercase;
      font-size: 11px;
      letter-spacing: 0;
    }
    .form {
      display: grid;
      gap: 6px;
      padding: 8px;
      border-bottom: 1px solid var(--border);
    }
    .row {
      display: grid;
      grid-template-columns: 1fr auto;
      gap: 4px;
      align-items: center;
    }
    .path-row {
      grid-template-columns: 1fr 32px;
    }
    .inline-row {
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: 4px;
    }
    .toggles {
      display: flex;
      gap: 3px;
      flex-wrap: wrap;
      color: var(--muted);
    }
    label {
      display: inline-flex;
      gap: 5px;
      align-items: center;
    }
    input {
      box-sizing: border-box;
      width: 100%;
      min-width: 0;
      border: 1px solid var(--vscode-input-border, transparent);
      color: var(--vscode-input-foreground);
      background: var(--vscode-input-background);
      padding: 5px 7px;
      font: inherit;
      min-height: 26px;
      outline: none;
    }
    input:focus {
      border-color: var(--vscode-focusBorder);
    }
    button {
      border: 1px solid var(--vscode-button-border, transparent);
      color: var(--vscode-button-foreground);
      background: var(--vscode-button-background);
      min-height: 26px;
      padding: 4px 8px;
      font: inherit;
      cursor: pointer;
    }
    button.secondary {
      color: var(--vscode-button-secondaryForeground);
      background: var(--vscode-button-secondaryBackground);
    }
    .icon-button {
      width: 32px;
      padding: 0;
      font-weight: 600;
    }
    .toggle {
      position: relative;
    }
    .toggle input {
      position: absolute;
      opacity: 0;
      pointer-events: none;
    }
    .toggle span {
      display: inline-grid;
      place-items: center;
      min-width: 27px;
      height: 24px;
      border: 1px solid transparent;
      color: var(--vscode-icon-foreground);
      background: transparent;
      cursor: pointer;
      font-size: 11px;
      font-weight: 600;
      user-select: none;
    }
    .toggle input:checked + span {
      color: var(--vscode-inputOption-activeForeground);
      border-color: var(--vscode-inputOption-activeBorder);
      background: var(--vscode-inputOption-activeBackground);
    }
    .toggle span:hover,
    .icon-button:hover,
    button.secondary:hover {
      background: var(--row-hover);
    }
    .status {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 8px;
      color: var(--muted);
      min-height: 26px;
      padding: 0 8px;
      border-bottom: 1px solid var(--border);
      font-size: 12px;
    }
    .results {
      padding: 4px 0 10px;
    }
    .file-group {
      border-bottom: 1px solid var(--border);
    }
    .file-header {
      width: 100%;
      display: flex;
      align-items: center;
      gap: 6px;
      min-height: 28px;
      padding: 0 8px;
      color: var(--vscode-foreground);
      background: transparent;
      box-sizing: border-box;
      font-weight: 600;
    }
    .file-name {
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .badge {
      margin-left: auto;
      min-width: 18px;
      padding: 1px 6px;
      color: var(--vscode-badge-foreground);
      background: var(--vscode-badge-background);
      border-radius: 10px;
      text-align: center;
      font-size: 11px;
      font-weight: 400;
    }
    .result {
      display: grid;
      grid-template-columns: 42px 1fr;
      gap: 6px;
      min-height: 26px;
      padding: 3px 8px 3px 18px;
      cursor: pointer;
      box-sizing: border-box;
    }
    .result:hover {
      background: var(--row-hover);
    }
    .line-number {
      color: var(--muted);
      text-align: right;
      font-variant-numeric: tabular-nums;
      user-select: none;
    }
    .line {
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
      color: var(--vscode-foreground);
    }
    .empty {
      padding: 18px 12px;
      color: var(--muted);
      text-align: center;
    }
  </style>
</head>
<body>
  <main class="stack">
    <header class="toolbar">
      <span>Find and grep</span>
      <span id="backend"></span>
    </header>
    <section class="form">
    <div class="row path-row">
      <input id="root" placeholder="Search folder" readonly>
      <button id="chooseFolder" class="secondary icon-button" title="Choose Folder">...</button>
    </div>
    <div class="row">
      <input id="pattern" placeholder="Find" autofocus>
      <button id="search">Search</button>
    </div>
    <div class="row">
      <input id="replacement" placeholder="Replace">
      <button id="replace" class="secondary">Replace All</button>
    </div>
    <input id="filter" placeholder="Filter results">
    <div class="inline-row">
      <input id="include" placeholder="Files to include">
      <input id="exclude" placeholder="Files to exclude">
    </div>
    <div class="toggles">
      <label class="toggle" title="Match Case"><input id="matchCase" type="checkbox"><span>Aa</span></label>
      <label class="toggle" title="Whole Word"><input id="wholeWord" type="checkbox"><span>Ab</span></label>
      <label class="toggle" title="Regular Expression"><input id="isRegex" type="checkbox"><span>.*</span></label>
      <label class="toggle" title="Filter Match Case"><input id="filterMatchCase" type="checkbox"><span>F Aa</span></label>
      <label class="toggle" title="Filter Whole Word"><input id="filterWholeWord" type="checkbox"><span>F Ab</span></label>
    </div>
    </section>
    <div id="status" class="status"></div>
    <section id="results" class="results"></section>
  </main>
  <script nonce="${nonce}">
    const vscode = acquireVsCodeApi();
    const state = { results: [] };
    const ids = ["pattern", "replacement", "filter", "include", "exclude", "matchCase", "wholeWord", "isRegex", "filterMatchCase", "filterWholeWord"];
    const els = Object.fromEntries(ids.map((id) => [id, document.getElementById(id)]));
    const status = document.getElementById("status");
    const resultsEl = document.getElementById("results");
    const rootEl = document.getElementById("root");
    const backendEl = document.getElementById("backend");
    rootEl.value = ${serializedInitialRoot};

    document.getElementById("chooseFolder").addEventListener("click", chooseFolder);
    document.getElementById("search").addEventListener("click", search);
    document.getElementById("replace").addEventListener("click", replaceAll);
    els.filter.addEventListener("input", render);
    els.pattern.addEventListener("keydown", (event) => {
      if (event.key === "Enter") search();
    });

    window.addEventListener("message", (event) => {
      const message = event.data;
      if (message.type === "searching") {
        status.textContent = "Searching...";
        backendEl.textContent = "";
      }
      if (message.type === "noWorkspace") {
        status.textContent = message.message;
        resultsEl.textContent = "";
        const button = document.createElement("button");
        button.textContent = "Choose Folder";
        button.addEventListener("click", chooseFolder);
        resultsEl.append(button);
      }
      if (message.type === "rootChanged") {
        rootEl.value = message.path;
        status.textContent = "Search folder selected.";
        resultsEl.textContent = "";
      }
      if (message.type === "results") {
        state.results = message.results;
        state.backend = message.backend || "";
        backendEl.textContent = state.backend;
        render();
      }
      if (message.type === "error") {
        status.textContent = message.message;
      }
    });

    function options() {
      return {
        pattern: els.pattern.value,
        replacement: els.replacement.value,
        filter: els.filter.value,
        include: els.include.value,
        exclude: els.exclude.value,
        matchCase: els.matchCase.checked,
        wholeWord: els.wholeWord.checked,
        isRegex: els.isRegex.checked,
        maxResults: 2000
      };
    }

    function search() {
      vscode.postMessage({ type: "search", options: options() });
    }

    function chooseFolder() {
      vscode.postMessage({ type: "chooseFolder" });
    }

    function replaceAll() {
      const filteredIds = filteredResults().map((result) => result.id);
      vscode.postMessage({ type: "replaceAll", options: { ...options(), onlyIds: filteredIds } });
    }

    function filteredResults() {
      const filter = els.filter.value.trim();
      if (!filter) return state.results;
      const matcher = textFilter(filter, {
        matchCase: els.filterMatchCase.checked,
        wholeWord: els.filterWholeWord.checked
      });
      return state.results.filter((result) => {
        return matcher(result.path) || matcher(result.text);
      });
    }

    function textFilter(filter, options) {
      if (!options.wholeWord) {
        const needle = options.matchCase ? filter : filter.toLocaleLowerCase();
        return (value) => {
          const haystack = options.matchCase ? value : value.toLocaleLowerCase();
          return haystack.includes(needle);
        };
      }

      const flags = options.matchCase ? "" : "i";
      const regex = new RegExp("\\\\b" + escapeRegExp(filter) + "\\\\b", flags);
      return (value) => regex.test(value);
    }

    function escapeRegExp(value) {
      return value.replace(new RegExp("[.*+?^" + "$" + "{}()|[\\\\]\\\\\\\\]", "g"), "\\\\$&");
    }

    function render() {
      const filtered = filteredResults();
      status.textContent = state.results.length
        ? filtered.length + " of " + state.results.length + " results"
        : "No results";
      resultsEl.textContent = "";

      if (!filtered.length) {
        const empty = document.createElement("div");
        empty.className = "empty";
        empty.textContent = state.results.length ? "No filtered results" : "Run a search to see results";
        resultsEl.append(empty);
        return;
      }

      for (const group of groupedByFile(filtered)) {
        const groupEl = document.createElement("section");
        groupEl.className = "file-group";

        const header = document.createElement("div");
        header.className = "file-header";
        const chevron = document.createElement("span");
        chevron.textContent = "⌄";
        const fileName = document.createElement("span");
        fileName.className = "file-name";
        fileName.textContent = group.path;
        const badge = document.createElement("span");
        badge.className = "badge";
        badge.textContent = String(group.items.length);
        header.append(chevron, fileName, badge);
        groupEl.append(header);

        for (const result of group.items) {
          const item = document.createElement("div");
          item.className = "result";
          item.tabIndex = 0;
          item.addEventListener("click", () => vscode.postMessage({ type: "openResult", id: result.id }));
          item.addEventListener("keydown", (event) => {
            if (event.key === "Enter") vscode.postMessage({ type: "openResult", id: result.id });
          });

          const lineNumber = document.createElement("div");
          lineNumber.className = "line-number";
          lineNumber.textContent = String(result.line + 1);
          const line = document.createElement("div");
          line.className = "line";
          line.textContent = result.text;
          item.append(lineNumber, line);
          groupEl.append(item);
        }

        resultsEl.append(groupEl);
      }
    }

    function groupedByFile(results) {
      const groups = [];
      const byPath = new Map();
      for (const result of results) {
        if (!byPath.has(result.path)) {
          const group = { path: result.path, items: [] };
          groups.push(group);
          byPath.set(result.path, group);
        }
        byPath.get(result.path).items.push(result);
      }
      return groups;
    }
  </script>
</body>
</html>`;
}

module.exports = {
  activate,
  deactivate
};
