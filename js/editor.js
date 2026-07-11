// ============================================================
// editor.js
// CodeMirror 5 (CDN) を使ったシンプルな JS エディタ
// importmap 不要・通常の script タグで動作
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
  fontSize:        13,
};

// ============================================================
// DOM 要素
// ============================================================
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
// CodeMirror 5 の初期化
// ============================================================
let cm; // CodeMirror インスタンス

window.addEventListener('DOMContentLoaded', () => {
  // textarea を CodeMirror に置き換える
  cm = CodeMirror.fromTextArea(document.getElementById('editor'), {
    mode:              'javascript',   // JavaScript モード
    theme:             'dracula',      // ダークテーマ
    lineNumbers:       true,           // 行番号
    matchBrackets:     true,           // 括弧の対応ハイライト
    autoCloseBrackets: true,           // 括弧の自動補完
    styleActiveLine:   true,           // 現在行ハイライト
    indentUnit:        4,              // インデント幅
    tabSize:           4,
    indentWithTabs:    false,          // タブではなくスペース
    lineWrapping:      false,          // 折り返しなし
    extraKeys: {
      // Tab でスペース4つ挿入
      'Tab': (cm) => cm.execCommand('insertSoftTab'),
    },
  });

  // サンプルコードをセット
  cm.setValue(SAMPLE_CODE);

  // カーソル移動時にステータスバーを更新
  cm.on('cursorActivity', updateStatusPos);

  // 変更時に未保存フラグを立てる
  cm.on('change', () => {
    state.isModified = true;
    updateTitle();
  });

  // エディタの高さを親要素に合わせる
  cm.setSize('100%', '100%');

  bindEvents();
  initResizer();
  updateStatusPos();
  setStatusMsg('準備完了');
});

// ============================================================
// コードの取得・セット
// ============================================================
function getCode()       { return cm.getValue(); }
function setCode(code)   { cm.setValue(code); }

// ============================================================
// イベントバインド
// ============================================================
function bindEvents() {
  document.addEventListener('keydown', onGlobalKeydown);

  searchInput.addEventListener('input', doSearch);
  searchInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter')  { e.shiftKey ? findPrev() : findNext(); e.preventDefault(); }
    if (e.key === 'Escape') closeSearch();
  });
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
  cm.focus();
}

function doSearch() {
  const query = searchInput.value;
  state.searchResults = [];
  if (!query) { searchCount.textContent = ''; return; }

  const code  = getCode();
  const regex = new RegExp(escapeRegex(query), 'gi');
  let m;
  while ((m = regex.exec(code)) !== null) {
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
  const from  = state.searchResults[state.searchIndex];
  const to    = from + searchInput.value.length;
  const code  = getCode();
  // 文字オフセットを CodeMirror の {line, ch} 形式に変換
  const fromPos = cm.posFromIndex(from);
  const toPos   = cm.posFromIndex(to);
  cm.setSelection(fromPos, toPos);
  cm.scrollIntoView({ from: fromPos, to: toPos }, 100);
  cm.focus();
}

function escapeRegex(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// ============================================================
// コメントアウト / 解除
// CodeMirror 5 の comment アドオンを使用
// ============================================================
function toggleComment() {
  cm.execCommand('toggleComment');
  cm.focus();
}

// ============================================================
// インデント整形
// ============================================================
function autoIndent() {
  const lines  = getCode().split('\n');
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

  setCode(result.join('\n'));
  setStatusMsg('インデントを整形しました');
}

// ============================================================
// ファイル操作
// ============================================================
function newFile() {
  if (state.isModified && !confirm('変更を破棄して新規作成しますか？')) return;
  setCode('');
  state.currentFileName = 'untitled.js';
  state.isModified      = false;
  updateTitle();
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
    setCode(ev.target.result);
    state.currentFileName = file.name;
    state.isModified      = false;
    updateTitle();
    setStatusMsg('ファイルを開きました: ' + file.name);
  };
  reader.readAsText(file, 'UTF-8');
  e.target.value = '';
}

function saveFile() {
  const blob = new Blob([getCode()], { type: 'text/javascript;charset=utf-8' });
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
  state.fontSize = Math.min(32, Math.max(8, state.fontSize + delta));
  // CodeMirror のラッパー要素にフォントサイズを適用
  document.querySelector('.CodeMirror').style.fontSize = state.fontSize + 'px';
  outputEl.style.fontSize = state.fontSize + 'px';
  // リフレッシュして表示を更新
  cm.refresh();
}

// ============================================================
// ステータスバー・タイトル更新
// ============================================================
function updateStatusPos() {
  const cursor = cm.getCursor();
  statusPos.textContent = '行: ' + (cursor.line + 1) + '  列: ' + (cursor.ch + 1);
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
    // リサイズ後に CodeMirror の表示を更新
    cm.refresh();
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

  const code = getCode().trim();
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
