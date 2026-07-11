// ============================================================
// editor.js
// textarea + ハイライトレイヤー方式のシンプルな JS エディタ。
//
// ハイライトの仕組み:
//   textarea を透明にして、真後ろの div（highlight-layer）に
//   色付きの HTML を表示する。スクロールを同期させることで
//   色がテキストに重なって見える。
//
// お節介な自動変換はしない方針:
//   ・括弧補完は「開き括弧を入力したとき閉じ括弧を追加」のみ
//   ・自動インデントは Enter 時に前行のインデントを引き継ぐのみ
//   ・それ以外のキー操作はブラウザのデフォルト動作に任せる
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
  hlTimer:         null,   // ハイライト遅延タイマー
};

// ============================================================
// DOM 要素
// ============================================================
const editor      = document.getElementById('editor');
const hlLayer     = document.getElementById('highlight-layer');
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
  syncLayout();
  scheduleHighlight();
  updateLineNumbers();
  updateStatusPos();
  bindEvents();
  initResizer();
  setStatusMsg('準備完了');
});

// ============================================================
// レイアウト同期
// textarea と highlight-layer の left 位置を行番号幅に合わせる
// ============================================================
function syncLayout() {
  const lineW = lineNumEl.offsetWidth;
  editor.style.left  = lineW + 'px';
  hlLayer.style.left = lineW + 'px';
}

// ============================================================
// シンタックスハイライト（トークナイザー方式）
//
// コードを先頭から1文字ずつ読み進め、
// コメント・文字列・数値・キーワードの順に判定する。
// コメントや文字列の中身は絶対にハイライトしない。
// ============================================================
function highlight(code) {

  const KEYWORDS = new Set([
    'async','await','break','case','catch','class','const','continue',
    'debugger','default','delete','do','else','export','extends',
    'finally','for','from','function','if','import','in','instanceof',
    'let','new','null','of','return','static','super','switch',
    'this','throw','true','false','try','typeof','undefined',
    'var','void','while','with','yield',
  ]);

  const BUILTINS = new Set([
    'Array','Boolean','console','Date','document','Error','Event',
    'fetch','JSON','Map','Math','Number','Object','Promise','Proxy',
    'Reflect','RegExp','Set','String','Symbol','WeakMap','WeakSet',
    'window','globalThis','setTimeout','setInterval',
    'clearTimeout','clearInterval','parseInt','parseFloat',
    'isNaN','isFinite','encodeURI','decodeURI','alert','confirm','prompt',
  ]);

  // HTML エスケープ（ハイライト HTML を壊さないため）
  function esc(s) {
    return s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
  }
  function span(cls, s) {
    return '<span class="' + cls + '">' + esc(s) + '</span>';
  }

  let out = '';
  let i   = 0;

  while (i < code.length) {

    // 1. 一行コメント //
    if (code[i] === '/' && code[i+1] === '/') {
      const end = code.indexOf('\n', i);
      const tok = end === -1 ? code.slice(i) : code.slice(i, end);
      out += span('hl-comment', tok);
      i   += tok.length;
      continue;
    }

    // 2. 複数行コメント /* */
    if (code[i] === '/' && code[i+1] === '*') {
      const end = code.indexOf('*/', i + 2);
      const tok = end === -1 ? code.slice(i) : code.slice(i, end + 2);
      out += span('hl-comment', tok);
      i   += tok.length;
      continue;
    }

    // 3. テンプレートリテラル `...`
    if (code[i] === '`') {
      let j = i + 1;
      while (j < code.length) {
        if (code[j] === '\\') { j += 2; continue; }
        if (code[j] === '`')  { j++;    break;    }
        j++;
      }
      out += span('hl-string', code.slice(i, j));
      i    = j;
      continue;
    }

    // 4. 文字列 "..." / '...'
    if (code[i] === '"' || code[i] === "'") {
      const q = code[i];
      let j   = i + 1;
      while (j < code.length) {
        if (code[j] === '\\') { j += 2; continue; }
        if (code[j] === '\n') { break; }
        if (code[j] === q)    { j++;   break; }
        j++;
      }
      out += span('hl-string', code.slice(i, j));
      i    = j;
      continue;
    }

    // 5. 数値
    if (/\d/.test(code[i]) && (i === 0 || !/[a-zA-Z_$]/.test(code[i-1]))) {
      const m = code.slice(i).match(/^(0x[\da-fA-F]+|\d+\.?\d*(?:e[+-]?\d+)?)/i);
      if (m) {
        out += span('hl-number', m[0]);
        i   += m[0].length;
        continue;
      }
    }

    // 6. 識別子（キーワード・組み込み・関数名）
    if (/[a-zA-Z_$]/.test(code[i])) {
      let j = i + 1;
      while (j < code.length && /[a-zA-Z0-9_$]/.test(code[j])) j++;
      const word = code.slice(i, j);

      if (KEYWORDS.has(word)) {
        out += span('hl-keyword', word);
      } else if (BUILTINS.has(word)) {
        out += span('hl-builtin', word);
      } else {
        // 直後に ( があれば関数名
        let k = j;
        while (k < code.length && code[k] === ' ') k++;
        out += code[k] === '(' ? span('hl-function', word) : esc(word);
      }
      i = j;
      continue;
    }

    // 7. 演算子
    if (/[+\-*/%=!&|^~<>?:;,.]/.test(code[i])) {
      let j = i + 1;
      while (j < code.length && /[+\-*/%=!&|^~<>?:]/.test(code[j])) j++;
      out += span('hl-operator', code.slice(i, j));
      i    = j;
      continue;
    }

    // 8. その他（空白・改行・括弧など）
    out += esc(code[i]);
    i++;
  }

  return out;
}

// ハイライトを 300ms 遅延して適用（デバウンス）
function scheduleHighlight() {
  clearTimeout(state.hlTimer);
  state.hlTimer = setTimeout(() => {
    hlLayer.innerHTML  = highlight(editor.value);
    // スクロール位置を再同期
    hlLayer.scrollTop  = editor.scrollTop;
    hlLayer.scrollLeft = editor.scrollLeft;
  }, 300);
}

// ============================================================
// 行番号の更新
// ============================================================
function updateLineNumbers() {
  const count = editor.value.split('\n').length;
  lineNumEl.textContent =
    Array.from({ length: count }, (_, i) => i + 1).join('\n');
  lineNumEl.scrollTop = editor.scrollTop;
}

// ============================================================
// イベントバインド
// ============================================================
function bindEvents() {
  editor.addEventListener('keydown', onEditorKeydown);
  editor.addEventListener('input',   onEditorInput);
  editor.addEventListener('scroll',  onEditorScroll);
  editor.addEventListener('click',   updateStatusPos);
  editor.addEventListener('keyup',   updateStatusPos);

  document.addEventListener('keydown', onGlobalKeydown);

  searchInput.addEventListener('input', doSearch);
  searchInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter')  { e.shiftKey ? findPrev() : findNext(); e.preventDefault(); }
    if (e.key === 'Escape') closeSearch();
  });

  // ウィンドウリサイズ時にレイアウトを再計算
  window.addEventListener('resize', syncLayout);
}

// ============================================================
// スクロール同期
// textarea のスクロールに highlight-layer と行番号を追従させる
// ============================================================
function onEditorScroll() {
  hlLayer.scrollTop    = editor.scrollTop;
  hlLayer.scrollLeft   = editor.scrollLeft;
  lineNumEl.scrollTop  = editor.scrollTop;
}

// ============================================================
// エディタ内キー操作
// ============================================================
function onEditorKeydown(e) {

  // ---- Tab: スペース4つを挿入 ----
  if (e.key === 'Tab') {
    e.preventDefault();
    insertAtCursor('    ');
    return;
  }

  // ---- Enter: 自動インデント ----
  // 前の行のインデント（先頭スペース）を引き継ぐ。
  // { で終わっていれば追加インデント。
  if (e.key === 'Enter') {
    e.preventDefault();
    const start      = editor.selectionStart;
    const before     = editor.value.substring(0, start);
    const lines      = before.split('\n');
    const lastLine   = lines[lines.length - 1];
    const indent     = lastLine.match(/^(\s*)/)[1];
    const extra      = lastLine.trimEnd().endsWith('{') ? '    ' : '';
    insertAtCursor('\n' + indent + extra);
    return;
  }

  // ---- 括弧補完 ----
  // 開き括弧を入力したとき、対応する閉じ括弧を自動追加する。
  // ただし「閉じ括弧を追加するだけ」で、それ以上の干渉はしない。
  // （カーソルを中に移動するだけで、閉じ括弧スキップ等はしない）
  const PAIRS = { '(': ')', '[': ']', '{': '}' };
  if (PAIRS[e.key]) {
    e.preventDefault();
    const start = editor.selectionStart;
    const end   = editor.selectionEnd;
    // テキストが選択されている場合は選択範囲を括弧で囲む
    if (start !== end) {
      const selected = editor.value.substring(start, end);
      insertAtCursor(e.key + selected + PAIRS[e.key]);
      // カーソルを閉じ括弧の前に移動
      editor.selectionStart = editor.selectionEnd = start + 1 + selected.length;
    } else {
      // 選択なし: 開き + 閉じを挿入してカーソルを中に置く
      insertAtCursor(e.key + PAIRS[e.key]);
      editor.selectionStart = editor.selectionEnd = start + 1;
    }
    onEditorInput();
    return;
  }

  // 引用符補完（" ' ` ）
  // 同じ引用符を開き・閉じとして扱う
  const QUOTES = ['"', "'", '`'];
  if (QUOTES.includes(e.key)) {
    e.preventDefault();
    const start = editor.selectionStart;
    const end   = editor.selectionEnd;
    if (start !== end) {
      // 選択範囲を引用符で囲む
      const selected = editor.value.substring(start, end);
      insertAtCursor(e.key + selected + e.key);
      editor.selectionStart = editor.selectionEnd = start + 1 + selected.length;
    } else {
      // 選択なし: 開き + 閉じを挿入してカーソルを中に置く
      insertAtCursor(e.key + e.key);
      editor.selectionStart = editor.selectionEnd = start + 1;
    }
    onEditorInput();
    return;
  }
}

// カーソル位置にテキストを挿入するユーティリティ
function insertAtCursor(text) {
  const start = editor.selectionStart;
  const end   = editor.selectionEnd;
  editor.value =
    editor.value.substring(0, start) + text + editor.value.substring(end);
  editor.selectionStart = editor.selectionEnd = start + text.length;
}

function onEditorInput() {
  state.isModified = true;
  updateTitle();
  updateLineNumbers();
  updateStatusPos();
  scheduleHighlight();
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
  highlightResult();
}

function findPrev() {
  doSearch();
  if (!state.searchResults.length) return;
  state.searchIndex =
    (state.searchIndex - 1 + state.searchResults.length) % state.searchResults.length;
  highlightResult();
}

function highlightResult() {
  const idx   = state.searchResults[state.searchIndex];
  const qlen  = searchInput.value.length;
  editor.focus();
  editor.setSelectionRange(idx, idx + qlen);
  const lineNo = editor.value.substring(0, idx).split('\n').length;
  const lineH  = parseFloat(getComputedStyle(editor).fontSize) * 1.6;
  editor.scrollTop = Math.max(0, (lineNo - 3) * lineH);
  onEditorScroll();
}

function escapeRegex(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// ============================================================
// コメントアウト / 解除
// ============================================================
function toggleComment() {
  const start = editor.selectionStart;
  const end   = editor.selectionEnd;
  const code  = editor.value;
  const sLine = code.substring(0, start).split('\n').length - 1;
  const eLine = code.substring(0, end).split('\n').length - 1;
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
  onEditorInput();
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
    onEditorInput();
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
// textarea・highlight-layer・行番号を同時に変更する
// ============================================================
function changeFontSize(delta) {
  const cur  = parseFloat(getComputedStyle(editor).fontSize);
  const next = Math.min(32, Math.max(8, cur + delta));
  const px   = next + 'px';
  editor.style.fontSize    = px;
  hlLayer.style.fontSize   = px;
  lineNumEl.style.fontSize = px;
  outputEl.style.fontSize  = px;
  updateLineNumbers();
  syncLayout();
}

// ============================================================
// ステータスバー・タイトル更新
// ============================================================
function updateStatusPos() {
  const pos   = editor.selectionStart;
  const text  = editor.value.substring(0, pos);
  const lines = text.split('\n');
  statusPos.textContent = '行: ' + lines.length + '  列: ' + (lines[lines.length-1].length + 1);
}

let statusTimer = null;
function setStatusMsg(msg) {
  statusMsg.textContent = msg;
  clearTimeout(statusTimer);
  statusTimer = setTimeout(() => { statusMsg.textContent = '準備完了'; }, 3000);
}

function updateTitle() {
  document.title = (state.isModified ? '● ' : '') + 'JS Editor - ' + state.currentFileName;
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
