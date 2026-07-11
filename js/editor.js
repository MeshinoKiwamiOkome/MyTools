// ============================================================
// editor.js  シンプル・快適操作版
//
// ・textarea をそのまま使う（文字は常に見える）
// ・ハイライトは廃止（操作感を最優先）
// ・括弧補完・自動インデントのみ実装
// ・それ以外のキー操作はブラウザに任せる
// ============================================================

'use strict';

// ============================================================
// 状態管理
// ============================================================
const state = {
  currentFileName: 'untitled.js',
  isModified:      false,
  isRunning:       false,
  stopRequested:   false,
  stdinQueue:      [],
  stdinResolvers:  [],
  searchResults:   [],
  searchIndex:     -1,
};

// ============================================================
// DOM 要素
// ============================================================
const editor      = document.getElementById('editor');
const lineNumEl   = document.getElementById('line-numbers');
const outputEl    = document.getElementById('output');
const runStatus   = document.getElementById('run-status');
const statusMsg   = document.getElementById('status-msg');
const statusPos   = document.getElementById('status-pos');
const searchBar   = document.getElementById('search-bar');
const searchInput = document.getElementById('search-input');
const searchCount = document.getElementById('search-count');
const stdinInput  = document.getElementById('stdin-input');

// ============================================================
// サンプルコード
// ============================================================
const SAMPLE_CODE =
`// ===== JavaScript エディタへようこそ！=====
// F5 または「▶ 実行」ボタンでコードを実行できます。

// --- 基本的な出力 ---
console.log('Hello, World!');

// --- 変数と演算 ---
const name = 'GitHub Pages';
const year = new Date().getFullYear();
console.log(name + ' で動く JS エディタ (' + year + '年)');

// --- 配列操作 ---
const nums = [1, 2, 3, 4, 5];
const doubled = nums.map(n => n * 2);
console.log('2倍:', doubled);

// --- 非同期処理 ---
async function fetchExample() {
  console.log('非同期処理のサンプル');
  await new Promise(r => setTimeout(r, 500));
  console.log('500ms 後に実行されました');
}
fetchExample();
`;

// ============================================================
// 初期化
// ============================================================
window.addEventListener('DOMContentLoaded', () => {
  editor.value = SAMPLE_CODE;
  updateLineNumbers();
  updateStatusPos();
  bindEvents();
  initResizer();
  setStatusMsg('準備完了');
});

// ============================================================
// 行番号の更新
// ============================================================
function updateLineNumbers() {
  const count = editor.value.split('\n').length;
  lineNumEl.textContent =
    Array.from({ length: count }, (_, i) => i + 1).join('\n');
  // textarea のスクロールと同期
  lineNumEl.scrollTop = editor.scrollTop;
}

// ============================================================
// イベントバインド
// ============================================================
function bindEvents() {
  editor.addEventListener('keydown', onEditorKeydown);
  editor.addEventListener('input',   onEditorInput);
  editor.addEventListener('scroll',  () => { lineNumEl.scrollTop = editor.scrollTop; });
  editor.addEventListener('click',   updateStatusPos);
  editor.addEventListener('keyup',   updateStatusPos);

  document.addEventListener('keydown', onGlobalKeydown);

  searchInput.addEventListener('input', doSearch);
  searchInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter')  { e.shiftKey ? findPrev() : findNext(); e.preventDefault(); }
    if (e.key === 'Escape') closeSearch();
  });
}

// ============================================================
// エディタ内キー操作
// ============================================================
function onEditorKeydown(e) {

  // ---- Tab: スペース4つ ----
  if (e.key === 'Tab') {
    e.preventDefault();
    insert('    ');
    return;
  }

  // ---- Enter: 自動インデント ----
  if (e.key === 'Enter') {
    e.preventDefault();
    const before    = editor.value.substring(0, editor.selectionStart);
    const lines     = before.split('\n');
    const lastLine  = lines[lines.length - 1];
    const indent    = lastLine.match(/^(\s*)/)[1];
    const extra     = lastLine.trimEnd().endsWith('{') ? '    ' : '';
    insert('\n' + indent + extra);
    return;
  }

  // ---- 括弧補完: ( [ { ----
  // 開き括弧を入力したとき閉じ括弧を追加してカーソルを中に置く
  const PAIRS = { '(': ')', '[': ']', '{': '}' };
  if (PAIRS[e.key]) {
    e.preventDefault();
    const s = editor.selectionStart;
    const e2 = editor.selectionEnd;
    if (s !== e2) {
      // テキスト選択中: 選択範囲を括弧で囲む
      const sel = editor.value.substring(s, e2);
      insert(e.key + sel + PAIRS[e.key]);
      editor.selectionStart = editor.selectionEnd = s + 1 + sel.length;
    } else {
      // 選択なし: 開き+閉じを挿入してカーソルを中に
      insert(e.key + PAIRS[e.key]);
      editor.selectionStart = editor.selectionEnd = s + 1;
    }
    onEditorInput();
    return;
  }

  // ---- 引用符補完: " ' ` ----
  if (e.key === '"' || e.key === "'" || e.key === '`') {
    e.preventDefault();
    const s  = editor.selectionStart;
    const e2 = editor.selectionEnd;
    if (s !== e2) {
      const sel = editor.value.substring(s, e2);
      insert(e.key + sel + e.key);
      editor.selectionStart = editor.selectionEnd = s + 1 + sel.length;
    } else {
      insert(e.key + e.key);
      editor.selectionStart = editor.selectionEnd = s + 1;
    }
    onEditorInput();
    return;
  }
}

// カーソル位置にテキストを挿入する
function insert(text) {
  const s = editor.selectionStart;
  const e = editor.selectionEnd;
  editor.value =
    editor.value.substring(0, s) + text + editor.value.substring(e);
  editor.selectionStart = editor.selectionEnd = s + text.length;
}

function onEditorInput() {
  state.isModified = true;
  updateTitle();
  updateLineNumbers();
  updateStatusPos();
}

// ============================================================
// グローバルショートカット
// ============================================================
function onGlobalKeydown(e) {
  const ctrl = e.ctrlKey || e.metaKey;
  if      (ctrl && e.key === 'n') { e.preventDefault(); newFile(); }
  else if (ctrl && e.key === 'o') { e.preventDefault(); openFile(); }
  else if (ctrl && e.key === 's') { e.preventDefault(); e.shiftKey ? saveAsFile() : saveFile(); }
  else if (ctrl && e.key === 'f') { e.preventDefault(); openSearch(); }
  else if (ctrl && e.key === '/') { e.preventDefault(); toggleComment(); }
  else if (ctrl && e.key === 'i') { e.preventDefault(); autoIndent(); }
  else if (ctrl && e.key === '=') { e.preventDefault(); changeFontSize(1); }
  else if (ctrl && e.key === '-') { e.preventDefault(); changeFontSize(-1); }
  else if (e.key === 'F5')        { e.preventDefault(); runCode(); }
  else if (e.key === 'F6')        { e.preventDefault(); stopCode(); }
  else if (e.key === 'F7')        { e.preventDefault(); clearOutput(); }
}

// ============================================================
// 検索
// ============================================================
function openSearch() {
  searchBar.classList.remove('hidden');
  searchInput.focus();
  searchInput.select();
}

function closeSearch() {
  searchBar.classList.add('hidden');
  state.searchResults     = [];
  state.searchIndex       = -1;
  searchCount.textContent = '';
  editor.focus();
}

function doSearch() {
  const query = searchInput.value;
  state.searchResults = [];
  if (!query) { searchCount.textContent = ''; return; }
  const regex = new RegExp(escapeRegex(query), 'gi');
  let m;
  while ((m = regex.exec(editor.value)) !== null) {
    state.searchResults.push(m.index);
  }
  searchCount.textContent =
    state.searchResults.length > 0
      ? state.searchResults.length + ' 件'
      : '見つかりません';
}

function findNext() {
  doSearch();
  if (!state.searchResults.length) return;
  state.searchIndex = (state.searchIndex + 1) % state.searchResults.length;
  jumpToResult();
}

function findPrev() {
  doSearch();
  if (!state.searchResults.length) return;
  state.searchIndex =
    (state.searchIndex - 1 + state.searchResults.length) % state.searchResults.length;
  jumpToResult();
}

function jumpToResult() {
  const idx  = state.searchResults[state.searchIndex];
  const qlen = searchInput.value.length;
  editor.focus();
  editor.setSelectionRange(idx, idx + qlen);
  // 該当行が見えるようにスクロール
  const lineNo = editor.value.substring(0, idx).split('\n').length;
  const lineH  = parseFloat(getComputedStyle(editor).fontSize) * 1.6;
  editor.scrollTop = Math.max(0, (lineNo - 3) * lineH);
  lineNumEl.scrollTop = editor.scrollTop;
}

function escapeRegex(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// ============================================================
// コメントアウト / 解除
// ============================================================
function toggleComment() {
  const s     = editor.selectionStart;
  const e     = editor.selectionEnd;
  const code  = editor.value;
  const sLine = code.substring(0, s).split('\n').length - 1;
  const eLine = code.substring(0, e).split('\n').length - 1;
  const lines = code.split('\n');

  const allCommented = lines
    .slice(sLine, eLine + 1)
    .filter(l => l.trim())
    .every(l => l.trimStart().startsWith('//'));

  const newLines = lines.map((line, i) => {
    if (i < sLine || i > eLine) return line;
    return allCommented
      ? line.replace(/^(\s*)\/\/\s?/, '$1')
      : line.replace(/^(\s*)/, '$1// ');
  });

  editor.value = newLines.join('\n');
  onEditorInput();
}

// ============================================================
// インデント整形
// ============================================================
function autoIndent() {
  const lines  = editor.value.split('\n');
  const result = [];
  let depth    = 0;
  const ind    = '    ';

  for (const line of lines) {
    const s = line.trim();
    if (!s) { result.push(''); continue; }
    if (/^[}\])]/.test(s)) depth = Math.max(0, depth - 1);
    result.push(ind.repeat(depth) + s);
    const opens  = (s.match(/[{[(]/g) || []).length;
    const closes = (s.match(/[}\])]/g) || []).length;
    depth = Math.max(0, depth + opens - closes);
  }

  editor.value = result.join('\n');
  onEditorInput();
  setStatusMsg('インデントを整形しました');
}

// ============================================================
// ファイル操作
// ============================================================
function newFile() {
  if (state.isModified && !confirm('変更を破棄して新規作成しますか？')) return;
  editor.value          = '';
  state.currentFileName = 'untitled.js';
  state.isModified      = false;
  updateTitle();
  updateLineNumbers();
  setStatusMsg('新規ファイルを作成しました');
}

function openFile() {
  document.getElementById('file-input').click();
}

function onFileSelected(e) {
  const file = e.target.files[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = (ev) => {
    editor.value         = ev.target.result;
    state.currentFileName = file.name;
    state.isModified      = false;
    updateTitle();
    updateLineNumbers();
    setStatusMsg('ファイルを開きました: ' + file.name);
  };
  reader.readAsText(file, 'UTF-8');
  e.target.value = '';
}

function saveFile() {
  const blob = new Blob([editor.value], { type: 'text/javascript;charset=utf-8' });
  const url  = URL.createObjectURL(blob);
  const a    = document.createElement('a');
  a.href = url; a.download = state.currentFileName; a.click();
  URL.revokeObjectURL(url);
  state.isModified = false;
  updateTitle();
  setStatusMsg('保存しました: ' + state.currentFileName);
}

function saveAsFile() {
  const name = prompt('ファイル名を入力してください', state.currentFileName);
  if (!name) return;
  state.currentFileName = name.endsWith('.js') ? name : name + '.js';
  saveFile();
}

// ============================================================
// フォントサイズ変更
// ============================================================
function changeFontSize(delta) {
  const cur  = parseFloat(getComputedStyle(editor).fontSize);
  const next = Math.min(32, Math.max(8, cur + delta));
  editor.style.fontSize    = next + 'px';
  lineNumEl.style.fontSize = next + 'px';
  outputEl.style.fontSize  = next + 'px';
  updateLineNumbers();
}

// ============================================================
// ステータスバー・タイトル更新
// ============================================================
function updateStatusPos() {
  const pos   = editor.selectionStart;
  const text  = editor.value.substring(0, pos);
  const lines = text.split('\n');
  statusPos.textContent =
    '行: ' + lines.length + '  列: ' + (lines[lines.length - 1].length + 1);
}

let statusTimer = null;
function setStatusMsg(msg) {
  statusMsg.textContent = msg;
  clearTimeout(statusTimer);
  statusTimer = setTimeout(() => { statusMsg.textContent = '準備完了'; }, 3000);
}

function updateTitle() {
  document.title =
    (state.isModified ? '● ' : '') + 'JS Editor - ' + state.currentFileName;
}

function setRunStatus(text, cls) {
  runStatus.textContent = '● ' + text;
  runStatus.className   = cls;
}

// ============================================================
// リサイズハンドル
// ============================================================
function initResizer() {
  const resizer    = document.getElementById('resizer');
  const editorPane = document.getElementById('editor-pane');
  const outputPane = document.getElementById('output-pane');
  let startY, startEH, startOH;

  resizer.addEventListener('mousedown', (e) => {
    startY  = e.clientY;
    startEH = editorPane.offsetHeight;
    startOH = outputPane.offsetHeight;
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup',   onUp);
    e.preventDefault();
  });

  function onMove(e) {
    const dy = e.clientY - startY;
    editorPane.style.flex = '0 0 ' + Math.max(80, startEH + dy) + 'px';
    outputPane.style.flex = '0 0 ' + Math.max(80, startOH - dy) + 'px';
  }
  function onUp() {
    document.removeEventListener('mousemove', onMove);
    document.removeEventListener('mouseup',   onUp);
  }
}

// ============================================================
// 実行エンジン
// ============================================================
function runCode() {
  if (state.isRunning) { stopCode(); return; }

  const code = editor.value.trim();
  if (!code) { appendOutput('⚠ コードが空です。\n', 'out-warning'); return; }

  clearOutput();
  state.isRunning      = false;
  state.stopRequested  = false;
  state.stdinQueue     = [];
  state.stdinResolvers = [];

  appendOutput('▶ 実行開始\n', 'out-info');
  setRunStatus('実行中', 'status-running');
  state.isRunning = true;

  const origConsole = {
    log:   console.log.bind(console),
    warn:  console.warn.bind(console),
    error: console.error.bind(console),
    info:  console.info.bind(console),
    table: console.table.bind(console),
  };

  function stringify(val) {
    if (val === null)            return 'null';
    if (val === undefined)       return 'undefined';
    if (typeof val === 'object') {
      try { return JSON.stringify(val, null, 2); } catch { return String(val); }
    }
    return String(val);
  }

  console.log   = (...a) => { appendOutput(a.map(stringify).join(' ') + '\n', 'out-stdout');          origConsole.log(...a);   };
  console.warn  = (...a) => { appendOutput('⚠ ' + a.map(stringify).join(' ') + '\n', 'out-warning'); origConsole.warn(...a);  };
  console.error = (...a) => { appendOutput('✖ ' + a.map(stringify).join(' ') + '\n', 'out-stderr');  origConsole.error(...a); };
  console.info  = (...a) => { appendOutput('ℹ ' + a.map(stringify).join(' ') + '\n', 'out-info');    origConsole.info(...a);  };
  console.table = (d)    => { appendOutput(tableToString(d) + '\n', 'out-stdout');                    origConsole.table(d);    };

  function readline(prompt = '') {
    if (prompt) appendOutput(prompt, 'out-info');
    return new Promise((resolve) => {
      if (state.stdinQueue.length > 0) { resolve(state.stdinQueue.shift()); return; }
      state.stdinResolvers.push(resolve);
    });
  }

  function tableToString(data) {
    if (!Array.isArray(data) || !data.length) return String(data);
    const keys   = Object.keys(data[0]);
    const header = keys.join(' | ');
    const sep    = keys.map(k => '-'.repeat(k.length)).join('-+-');
    const rows   = data.map(r => keys.map(k => String(r[k] ?? '')).join(' | '));
    return [header, sep, ...rows].join('\n');
  }

  const AsyncFunction = Object.getPrototypeOf(async function(){}).constructor;
  let execPromise;
  try {
    execPromise = new AsyncFunction('readline', code)(readline);
  } catch (err) {
    appendOutput('✖ 構文エラー: ' + err.message + '\n', 'out-stderr');
    finishRun(false);
    Object.assign(console, origConsole);
    return;
  }

  execPromise
    .then(() => {
      if (!state.stopRequested) {
        appendOutput('\n✅ 正常終了\n', 'out-success');
        finishRun(true);
      }
    })
    .catch((err) => {
      appendOutput('\n✖ 実行エラー: ' + err.message + '\n', 'out-stderr');
      finishRun(false);
    })
    .finally(() => { Object.assign(console, origConsole); });
}

function finishRun(success) {
  state.isRunning      = false;
  state.stdinResolvers = [];
  state.stdinQueue     = [];
  setRunStatus(success ? '完了' : 'エラー', success ? 'status-done' : 'status-error');
}

function stopCode() {
  if (!state.isRunning) { setRunStatus('待機中', 'status-idle'); return; }
  state.stopRequested = true;
  state.isRunning     = false;
  state.stdinResolvers.forEach(r => r(''));
  state.stdinResolvers = [];
  appendOutput('\n⏹ 実行を停止しました。\n', 'out-warning');
  setRunStatus('停止', 'status-stopped');
}

function clearOutput() {
  outputEl.innerHTML = '';
  setRunStatus('待機中', 'status-idle');
}

function appendOutput(text, cls = 'out-stdout') {
  const span       = document.createElement('span');
  span.className   = cls;
  span.textContent = text;
  outputEl.appendChild(span);
  outputEl.scrollTop = outputEl.scrollHeight;
}

function sendStdin() {
  const text       = stdinInput.value;
  stdinInput.value = '';
  appendOutput('> ' + text + '\n', 'out-info');
  if (state.stdinResolvers.length > 0) {
    state.stdinResolvers.shift()(text);
  } else {
    state.stdinQueue.push(text);
  }
}
