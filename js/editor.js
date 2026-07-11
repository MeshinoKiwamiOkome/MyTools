// ============================================================
// editor.js  - シンプル版
// textarea ベースのエディタ。
// お節介な自動変換は一切なし。
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
// textarea のスクロール位置と同期する
// ============================================================
function updateLineNumbers() {
  const lines = editor.value.split('\n');
  const total = lines.length;
  lineNumEl.textContent = Array.from({ length: total }, (_, i) => i + 1).join('\n');
  // textarea のスクロール位置に行番号を同期
  lineNumEl.scrollTop = editor.scrollTop;
}

// ============================================================
// イベントバインド
// ============================================================
function bindEvents() {
  // キー入力
  editor.addEventListener('keydown', onEditorKeydown);
  editor.addEventListener('input',   onEditorInput);
  editor.addEventListener('scroll',  onEditorScroll);
  editor.addEventListener('click',   updateStatusPos);
  editor.addEventListener('keyup',   updateStatusPos);

  // グローバルショートカット
  document.addEventListener('keydown', onGlobalKeydown);

  // 検索入力
  searchInput.addEventListener('input',   doSearch);
  searchInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter')  { e.shiftKey ? findPrev() : findNext(); e.preventDefault(); }
    if (e.key === 'Escape') closeSearch();
  });
}

// ============================================================
// エディタのスクロールに行番号を同期
// ============================================================
function onEditorScroll() {
  lineNumEl.scrollTop = editor.scrollTop;
}

// ============================================================
// エディタ内キー操作
// お節介な自動変換はせず、Tab のみスペース4つに変換する
// ============================================================
function onEditorKeydown(e) {
  // Tab → スペース4つ（フォーカス移動を防ぐ）
  if (e.key === 'Tab') {
    e.preventDefault();
    const start = editor.selectionStart;
    const end   = editor.selectionEnd;
    editor.value =
      editor.value.substring(0, start) + '    ' + editor.value.substring(end);
    editor.selectionStart = editor.selectionEnd = start + 4;
    onEditorInput();
    return;
  }

  // Enter → 前の行のインデントを引き継ぐ
  if (e.key === 'Enter') {
    e.preventDefault();
    const start      = editor.selectionStart;
    const textBefore = editor.value.substring(0, start);
    const lines      = textBefore.split('\n');
    const lastLine   = lines[lines.length - 1];
    const indent     = lastLine.match(/^(\s*)/)[1];
    // { で終わっていれば追加インデント
    const extra      = lastLine.trimEnd().endsWith('{') ? '    ' : '';
    const insert     = '\n' + indent + extra;
    editor.value =
      editor.value.substring(0, start) + insert + editor.value.substring(editor.selectionEnd);
    editor.selectionStart = editor.selectionEnd = start + insert.length;
    onEditorInput();
    return;
  }
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
  if (ctrl && e.key === 'n')      { e.preventDefault(); newFile(); }
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

  const code  = editor.value;
  const regex = new RegExp(escapeRegex(query), 'gi');
  let match;
  while ((match = regex.exec(code)) !== null) {
    state.searchResults.push(match.index);
  }
  searchCount.textContent =
    state.searchResults.length > 0
      ? `${state.searchResults.length} 件`
      : '見つかりません';
}

function findNext() {
  doSearch();
  if (state.searchResults.length === 0) return;
  state.searchIndex = (state.searchIndex + 1) % state.searchResults.length;
  highlightResult();
}

function findPrev() {
  doSearch();
  if (state.searchResults.length === 0) return;
  state.searchIndex =
    (state.searchIndex - 1 + state.searchResults.length) % state.searchResults.length;
  highlightResult();
}

function highlightResult() {
  const idx   = state.searchResults[state.searchIndex];
  const query = searchInput.value;
  // textarea の選択範囲を検索結果に移動
  editor.focus();
  editor.setSelectionRange(idx, idx + query.length);
  // 該当行が見えるようにスクロール
  const lineNo = editor.value.substring(0, idx).split('\n').length;
  const lineH  = parseFloat(getComputedStyle(editor).fontSize) * 1.6;
  editor.scrollTop = Math.max(0, (lineNo - 3) * lineH);
  lineNumEl.scrollTop = editor.scrollTop;
}

function escapeRegex(str) {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// ============================================================
// コメントアウト / 解除
// ============================================================
function toggleComment() {
  const start = editor.selectionStart;
  const end   = editor.selectionEnd;
  const code  = editor.value;

  // 選択範囲の開始・終了行番号を求める
  const startLine = code.substring(0, start).split('\n').length - 1;
  const endLine   = code.substring(0, end).split('\n').length - 1;
  const lines     = code.split('\n');

  // 対象行が全てコメントアウトされているか確認
  const allCommented = lines
    .slice(startLine, endLine + 1)
    .filter(l => l.trim())
    .every(l => l.trimStart().startsWith('//'));

  const newLines = lines.map((line, i) => {
    if (i < startLine || i > endLine) return line;
    if (allCommented) {
      return line.replace(/^(\s*)\/\/\s?/, '$1');  // コメント解除
    } else {
      return line.replace(/^(\s*)/, '$1// ');       // コメントアウト
    }
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
  const indent = '    ';

  for (const line of lines) {
    const stripped = line.trim();
    if (!stripped) { result.push(''); continue; }
    if (/^[}\])]/.test(stripped)) depth = Math.max(0, depth - 1);
    result.push(indent.repeat(depth) + stripped);
    const opens  = (stripped.match(/[{[(]/g) || []).length;
    const closes = (stripped.match(/[}\])]/g) || []).length;
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
  a.href     = url;
  a.download = state.currentFileName;
  a.click();
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
  const current = parseFloat(getComputedStyle(editor).fontSize);
  const next    = Math.min(32, Math.max(8, current + delta));
  editor.style.fontSize    = next + 'px';
  lineNumEl.style.fontSize = next + 'px';
  outputEl.style.fontSize  = next + 'px';
  updateLineNumbers();
}

// ============================================================
// ステータスバー・タイトル更新
// ============================================================
function updateStatusPos() {
  const pos    = editor.selectionStart;
  const text   = editor.value.substring(0, pos);
  const lines  = text.split('\n');
  const line   = lines.length;
  const col    = lines[lines.length - 1].length + 1;
  statusPos.textContent = '行: ' + line + '  列: ' + col;
}

let statusTimer = null;
function setStatusMsg(msg) {
  statusMsg.textContent = msg;
  clearTimeout(statusTimer);
  statusTimer = setTimeout(() => { statusMsg.textContent = '準備完了'; }, 3000);
}

function updateTitle() {
  const prefix = state.isModified ? '● ' : '';
  document.title = prefix + 'JS Editor - ' + state.currentFileName;
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
  let startY, startEditorH, startOutputH;

  resizer.addEventListener('mousedown', (e) => {
    startY       = e.clientY;
    startEditorH = editorPane.offsetHeight;
    startOutputH = outputPane.offsetHeight;
    document.addEventListener('mousemove', onMouseMove);
    document.addEventListener('mouseup',   onMouseUp);
    e.preventDefault();
  });

  function onMouseMove(e) {
    const dy = e.clientY - startY;
    editorPane.style.flex = '0 0 ' + Math.max(80, startEditorH + dy) + 'px';
    outputPane.style.flex = '0 0 ' + Math.max(80, startOutputH - dy) + 'px';
  }

  function onMouseUp() {
    document.removeEventListener('mousemove', onMouseMove);
    document.removeEventListener('mouseup',   onMouseUp);
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

  // console をオーバーライドして出力をキャプチャ
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

  // 疑似 readline（stdin 入力待ち）
  function readline(prompt = '') {
    if (prompt) appendOutput(prompt, 'out-info');
    return new Promise((resolve) => {
      if (state.stdinQueue.length > 0) { resolve(state.stdinQueue.shift()); return; }
      state.stdinResolvers.push(resolve);
    });
  }

  function tableToString(data) {
    if (!Array.isArray(data) || data.length === 0) return String(data);
    const keys   = Object.keys(data[0]);
    const header = keys.join(' | ');
    const sep    = keys.map(k => '-'.repeat(k.length)).join('-+-');
    const rows   = data.map(row => keys.map(k => String(row[k] ?? '')).join(' | '));
    return [header, sep, ...rows].join('\n');
  }

  // AsyncFunction でコードをラップして実行
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
    .finally(() => {
      Object.assign(console, origConsole);
    });
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
