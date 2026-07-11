// ============================================================
// editor.js
// GitHub Pages 対応 JavaScript エディタ
// ブラウザ上で動作。Node.js 不要。
// eval() + console のオーバーライドで実行結果をキャプチャする。
// ============================================================

'use strict';

// ============================================================
// 状態管理
// ============================================================
const state = {
  isModified:       false,   // 未保存の変更があるか
  currentFileName:  'untitled.js',
  isRunning:        false,   // 実行中か
  stopRequested:    false,   // 停止リクエストが来たか
  undoStack:        [],      // Undo 履歴
  redoStack:        [],      // Redo 履歴
  searchResults:    [],      // 検索結果の位置リスト
  searchIndex:      -1,      // 現在の検索位置
  acIndex:          -1,      // 補完候補の選択インデックス
  acMatches:        [],      // 補完候補リスト
  highlightTimer:   null,    // ハイライト遅延タイマー
  acTimer:          null,    // 補完遅延タイマー
  stdinQueue:       [],      // stdin 入力キュー（疑似 readline 用）
  stdinResolvers:   [],      // stdin の Promise resolver キュー
};

// ============================================================
// DOM 要素の参照
// ============================================================
const editorEl    = document.getElementById('editor');
const lineNumEl   = document.getElementById('line-numbers');
const outputEl    = document.getElementById('output');
const runStatus   = document.getElementById('run-status');
const statusMsg   = document.getElementById('status-msg');
const statusPos   = document.getElementById('status-pos');
const searchBar   = document.getElementById('search-bar');
const searchInput = document.getElementById('search-input');
const searchCount = document.getElementById('search-count');
const stdinInput  = document.getElementById('stdin-input');
const acPopup     = document.createElement('div');

// 補完ポップアップを body に追加
acPopup.id = 'autocomplete';
acPopup.classList.add('hidden');
document.body.appendChild(acPopup);

// ============================================================
// サンプルコード（起動時に表示）
// ============================================================
const SAMPLE_CODE = `// ===== JavaScript エディタへようこそ！=====
// F5 または「▶ 実行」ボタンでコードを実行できます。

// --- 基本的な出力 ---
console.log('Hello, World!');

// --- 変数と演算 ---
const name = 'GitHub Pages';
const year = new Date().getFullYear();
console.log(\`\${name} で動く JS エディタ (\${year}年)\`);

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
  setEditorText(SAMPLE_CODE);
  updateLineNumbers();
  scheduleHighlight();
  bindEvents();
  initResizer();
  setStatusMsg('準備完了');
});

// ============================================================
// エディタのテキスト操作ユーティリティ
// ============================================================

/** エディタの生テキスト（ハイライト用スパンを除いた純粋なコード）を返す */
function getCode() {
  return editorEl.innerText;
}

/** エディタにテキストをセットする（ハイライトも適用） */
function setEditorText(code) {
  editorEl.innerHTML = highlight(code);
  updateLineNumbers();
}

// ============================================================
// シンタックスハイライト
// ============================================================

/**
 * コード文字列を HTML（スパンタグ付き）に変換して返す。
 * 正規表現ベースの簡易ハイライター。
 * XSS 対策として < > & をエスケープしてからタグを挿入する。
 */
function highlight(code) {
  // まず HTML 特殊文字をエスケープ
  const escaped = code
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');

  // トークンの優先順位順に正規表現を定義
  const rules = [
    // コメント（// 〜 行末）
    { cls: 'hl-comment',  re: /(\/\/[^\n]*)/g },
    // コメント（/* 〜 */）
    { cls: 'hl-comment',  re: /(\/\*[\s\S]*?\*\/)/g },
    // テンプレートリテラル（` 〜 `）
    { cls: 'hl-string',   re: /(`(?:\\.|[^`\\])*`)/g },
    // ダブルクォート文字列
    { cls: 'hl-string',   re: /("(?:\\.|[^"\\])*")/g },
    // シングルクォート文字列
    { cls: 'hl-string',   re: /('(?:\\.|[^'\\])*')/g },
    // 数値（整数・浮動小数点・16進数）
    { cls: 'hl-number',   re: /\b(0x[\da-fA-F]+|\d+\.?\d*(?:e[+-]?\d+)?)\b/g },
    // キーワード
    { cls: 'hl-keyword',  re: /\b(async|await|break|case|catch|class|const|continue|debugger|default|delete|do|else|export|extends|finally|for|from|function|if|import|in|instanceof|let|new|null|of|return|static|super|switch|this|throw|true|false|try|typeof|undefined|var|void|while|with|yield)\b/g },
    // 組み込みオブジェクト・関数
    { cls: 'hl-builtin',  re: /\b(Array|Boolean|console|Date|document|Error|Event|fetch|JSON|Map|Math|Number|Object|Promise|Proxy|Reflect|RegExp|Set|String|Symbol|WeakMap|WeakSet|window|globalThis|setTimeout|setInterval|clearTimeout|clearInterval|parseInt|parseFloat|isNaN|isFinite|encodeURI|decodeURI|alert|confirm|prompt)\b/g },
    // 関数名（function キーワードの後、または () の前の識別子）
    { cls: 'hl-function', re: /\b([a-zA-Z_$][a-zA-Z0-9_$]*)\s*(?=\()/g },
    // 演算子
    { cls: 'hl-operator', re: /([+\-*/%=!&|^~<>?:]+)/g },
  ];

  // プレースホルダー方式でトークンを順番に置換
  // （後の置換が前の結果を壊さないようにするため）
  const tokens = [];
  let result = escaped;

  for (const { cls, re } of rules) {
    result = result.replace(re, (match) => {
      const idx = tokens.length;
      tokens.push(`<span class="${cls}">${match}</span>`);
      return `\x00${idx}\x00`;  // 一時プレースホルダー
    });
  }

  // プレースホルダーを実際のスパンタグに戻す
  result = result.replace(/\x00(\d+)\x00/g, (_, i) => tokens[Number(i)]);

  return result;
}

/**
 * ハイライトを遅延実行する（デバウンス）。
 * キー入力のたびに即時実行すると重いため 300ms 待つ。
 * カーソル位置を保持してから適用する。
 */
function scheduleHighlight() {
  clearTimeout(state.highlightTimer);
  state.highlightTimer = setTimeout(() => {
    const code = getCode();
    const sel  = saveSelection(editorEl);
    editorEl.innerHTML = highlight(code);
    if (sel) restoreSelection(editorEl, sel);
    updateLineNumbers();
  }, 300);
}

// ============================================================
// 行番号の更新
// ============================================================

/** エディタの行数に合わせて行番号を再描画する */
function updateLineNumbers() {
  const lines = getCode().split('\n');
  lineNumEl.textContent = lines.map((_, i) => i + 1).join('\n');
}

// ============================================================
// カーソル位置の保存・復元
// ============================================================

/**
 * contenteditable 内のカーソル位置（文字オフセット）を保存する。
 * ハイライト再描画後に DOM が変わっても位置を復元できるようにする。
 */
function saveSelection(el) {
  const sel = window.getSelection();
  if (!sel || sel.rangeCount === 0) return null;
  const range    = sel.getRangeAt(0);
  const preRange = document.createRange();
  preRange.selectNodeContents(el);
  preRange.setEnd(range.startContainer, range.startOffset);
  const start = preRange.toString().length;
  return { start, end: start + range.toString().length };
}

/**
 * 保存したカーソル位置を復元する。
 * テキストノードを走査して文字オフセットから DOM ノード位置に変換する。
 */
function restoreSelection(el, saved) {
  const sel = window.getSelection();
  if (!sel) return;

  function findNode(node, offset) {
    if (node.nodeType === Node.TEXT_NODE) {
      if (offset <= node.textContent.length) {
        return { node, offset };
      }
      return { node, offset: -1, remaining: offset - node.textContent.length };
    }
    let remaining = offset;
    for (const child of node.childNodes) {
      const result = findNode(child, remaining);
      if (result.offset !== -1) return result;
      remaining = result.remaining;
    }
    return { node, offset: -1, remaining };
  }

  try {
    const startPos = findNode(el, saved.start);
    const endPos   = findNode(el, saved.end);
    if (startPos.offset === -1 || endPos.offset === -1) return;
    const range = document.createRange();
    range.setStart(startPos.node, startPos.offset);
    range.setEnd(endPos.node, endPos.offset);
    sel.removeAllRanges();
    sel.addRange(range);
  } catch (e) {
    // 復元失敗は無視（ハイライト後にカーソルが先頭に戻るだけ）
  }
}

// ============================================================
// カーソル位置の取得（行・列）
// ============================================================

/** カーソルの行番号と列番号を返す */
function getCursorPosition() {
  const sel = window.getSelection();
  if (!sel || sel.rangeCount === 0) return { line: 1, col: 1 };
  const range    = sel.getRangeAt(0);
  const preRange = document.createRange();
  preRange.selectNodeContents(editorEl);
  preRange.setEnd(range.startContainer, range.startOffset);
  const text  = preRange.toString();
  const lines = text.split('\n');
  return { line: lines.length, col: lines[lines.length - 1].length + 1 };
}

// ============================================================
// イベントバインド
// ============================================================

function bindEvents() {
  // キーボードショートカット（グローバル）
  document.addEventListener('keydown', onGlobalKeydown);

  // エディタ内のキー操作
  editorEl.addEventListener('keydown',  onEditorKeydown);
  editorEl.addEventListener('keyup',    onEditorKeyup);
  editorEl.addEventListener('mouseup',  onEditorMouseup);
  editorEl.addEventListener('input',    onEditorInput);

  // 検索入力
  searchInput.addEventListener('input', () => doSearch());
  searchInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter')  { e.shiftKey ? findPrev() : findNext(); e.preventDefault(); }
    if (e.key === 'Escape') closeSearch();
  });

  // 補完ポップアップ外クリックで閉じる
  document.addEventListener('mousedown', (e) => {
    if (!acPopup.contains(e.target)) hideAutocomplete();
  });
}

// ============================================================
// グローバルキーボードショートカット
// ============================================================

function onGlobalKeydown(e) {
  const ctrl = e.ctrlKey || e.metaKey;

  if (ctrl && e.key === 'n')        { e.preventDefault(); newFile(); }
  else if (ctrl && e.key === 'o')   { e.preventDefault(); openFile(); }
  else if (ctrl && e.key === 's')   { e.preventDefault(); e.shiftKey ? saveAsFile() : saveFile(); }
  else if (ctrl && e.key === 'z')   { e.preventDefault(); editorUndo(); }
  else if (ctrl && e.key === 'y')   { e.preventDefault(); editorRedo(); }
  else if (ctrl && e.key === 'f')   { e.preventDefault(); openSearch(); }
  else if (ctrl && e.key === '/')   { e.preventDefault(); toggleComment(); }
  else if (ctrl && e.key === 'i')   { e.preventDefault(); autoIndent(); }
  else if (ctrl && e.key === '=')   { e.preventDefault(); changeFontSize(1); }
  else if (ctrl && e.key === '-')   { e.preventDefault(); changeFontSize(-1); }
  else if (e.key === 'F5')          { e.preventDefault(); runCode(); }
  else if (e.key === 'F6')          { e.preventDefault(); stopCode(); }
  else if (e.key === 'F7')          { e.preventDefault(); clearOutput(); }
}

// ============================================================
// エディタ内キー操作
// ============================================================

function onEditorKeydown(e) {
  // 補完ポップアップが表示中のキー操作
  if (!acPopup.classList.contains('hidden')) {
    if (e.key === 'ArrowDown')  { e.preventDefault(); moveAc(1);  return; }
    if (e.key === 'ArrowUp')    { e.preventDefault(); moveAc(-1); return; }
    if (e.key === 'Tab' || e.key === 'Enter') {
      e.preventDefault();
      applyAutocomplete();
      return;
    }
    if (e.key === 'Escape') { hideAutocomplete(); return; }
  }

  // Tab → スペース4つ
  if (e.key === 'Tab') {
    e.preventDefault();
    insertText('    ');
    return;
  }

  // Enter → 自動インデント
  if (e.key === 'Enter') {
    e.preventDefault();
    handleEnter();
    return;
  }

  // 括弧・引用符の自動補完
  const pairs = { '(': ')', '[': ']', '{': '}', '"': '"', "'": "'", '`': '`' };
  if (pairs[e.key]) {
    e.preventDefault();
    handleAutoPair(e.key, pairs[e.key]);
    return;
  }

  // 閉じ括弧のスキップ（次の文字が同じなら移動するだけ）
  const closers = new Set([')', ']', '}']);
  if (closers.has(e.key)) {
    const next = getCharAfterCursor();
    if (next === e.key) {
      e.preventDefault();
      moveCursorRight();
      return;
    }
  }

  // Backspace → スペース4つを一括削除
  if (e.key === 'Backspace') {
    if (handleBackspace()) { e.preventDefault(); return; }
  }
}

function onEditorKeyup(e) {
  updateStatusPos();
  scheduleHighlight();

  // 補完不要なキーは補完を閉じる
  const skipKeys = new Set([
    'Enter', 'Tab', 'Escape', 'Backspace', 'Delete',
    'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight',
    'Home', 'End', 'PageUp', 'PageDown', ' ',
    'Shift', 'Control', 'Alt', 'Meta', 'CapsLock',
  ]);
  if (skipKeys.has(e.key)) {
    hideAutocomplete();
    return;
  }

  // 補完を 400ms 後に表示（デバウンス）
  clearTimeout(state.acTimer);
  state.acTimer = setTimeout(showAutocomplete, 400);
}

function onEditorMouseup() {
  updateStatusPos();
  hideAutocomplete();
}

function onEditorInput() {
  state.isModified = true;
  updateTitle();
}

// ============================================================
// テキスト挿入ユーティリティ
// ============================================================

/** カーソル位置にテキストを挿入する */
function insertText(text) {
  document.execCommand('insertText', false, text);
}

/** カーソルの直後の1文字を返す */
function getCharAfterCursor() {
  const sel = window.getSelection();
  if (!sel || sel.rangeCount === 0) return '';
  const range = sel.getRangeAt(0).cloneRange();
  range.collapse(false);
  range.setEnd(range.startContainer, range.startOffset + 1);
  return range.toString();
}

/** カーソルを1文字右に移動する */
function moveCursorRight() {
  const sel = window.getSelection();
  if (!sel || sel.rangeCount === 0) return;
  const range = sel.getRangeAt(0);
  range.setStart(range.startContainer, range.startOffset + 1);
  range.collapse(true);
  sel.removeAllRanges();
  sel.addRange(range);
}

// ============================================================
// Enter キー処理（自動インデント）
// ============================================================

function handleEnter() {
  const sel = window.getSelection();
  if (!sel || sel.rangeCount === 0) return;

  // カーソル行のテキストを取得してインデント量を計算
  const range    = sel.getRangeAt(0);
  const preRange = document.createRange();
  preRange.selectNodeContents(editorEl);
  preRange.setEnd(range.startContainer, range.startOffset);
  const textBefore = preRange.toString();
  const lines      = textBefore.split('\n');
  const currentLine = lines[lines.length - 1];
  const indent      = currentLine.match(/^(\s*)/)[1];

  // { で終わっていれば追加インデント
  const extra = currentLine.trimEnd().endsWith('{') ? '    ' : '';
  insertText('\n' + indent + extra);
}

// ============================================================
// Backspace 処理（スペース4つの一括削除）
// ============================================================

/** カーソル直前がスペース4つなら一括削除して true を返す */
function handleBackspace() {
  const sel = window.getSelection();
  if (!sel || sel.rangeCount === 0) return false;
  const range    = sel.getRangeAt(0);
  const preRange = document.createRange();
  preRange.selectNodeContents(editorEl);
  preRange.setEnd(range.startContainer, range.startOffset);
  const text = preRange.toString();
  if (text.endsWith('    ')) {
    // スペース4つを選択して削除
    const newRange = range.cloneRange();
    newRange.setStart(range.startContainer,
                      range.startOffset - 4);
    sel.removeAllRanges();
    sel.addRange(newRange);
    document.execCommand('delete');
    return true;
  }
  return false;
}

// ============================================================
// 括弧・引用符の自動補完
// ============================================================

function handleAutoPair(open, close) {
  const sel = window.getSelection();
  if (!sel) return;

  // テキストが選択されている場合は選択範囲を括弧で囲む
  if (!sel.isCollapsed) {
    const selected = sel.toString();
    insertText(open + selected + close);
    return;
  }

  // 引用符で次の文字が同じなら閉じ括弧をスキップ
  if (open === close && getCharAfterCursor() === close) {
    moveCursorRight();
    return;
  }

  // 開き括弧 + 閉じ括弧を挿入してカーソルを中に移動
  insertText(open + close);
  moveCursorRight(); // 一時的に右に移動
  // カーソルを閉じ括弧の前に戻す
  const range = sel.getRangeAt(0);
  range.setStart(range.startContainer, range.startOffset - 1);
  range.collapse(true);
  sel.removeAllRanges();
  sel.addRange(range);
}

// ============================================================
// 自動補完
// ============================================================

const JS_KEYWORDS = [
  'async', 'await', 'break', 'case', 'catch', 'class', 'const', 'continue',
  'debugger', 'default', 'delete', 'do', 'else', 'export', 'extends',
  'finally', 'for', 'from', 'function', 'if', 'import', 'in', 'instanceof',
  'let', 'new', 'null', 'of', 'return', 'static', 'super', 'switch',
  'this', 'throw', 'true', 'false', 'try', 'typeof', 'undefined', 'var',
  'void', 'while', 'yield',
  'Array', 'Boolean', 'console', 'Date', 'document', 'Error', 'fetch',
  'JSON', 'Map', 'Math', 'Number', 'Object', 'Promise', 'Set', 'String',
  'Symbol', 'window', 'globalThis', 'setTimeout', 'setInterval',
  'clearTimeout', 'clearInterval', 'parseInt', 'parseFloat', 'isNaN',
  'isFinite', 'alert', 'confirm', 'prompt',
  'addEventListener', 'querySelector', 'querySelectorAll', 'getElementById',
  'forEach', 'map', 'filter', 'reduce', 'find', 'findIndex', 'includes',
  'push', 'pop', 'shift', 'unshift', 'splice', 'slice', 'join', 'sort',
  'reverse', 'flat', 'flatMap', 'toString', 'valueOf', 'hasOwnProperty',
  'keys', 'values', 'entries', 'assign', 'freeze', 'create',
  'log', 'warn', 'error', 'info', 'table', 'time', 'timeEnd',
];

/** カーソル直前の識別子を返す */
function getCurrentWord() {
  const sel = window.getSelection();
  if (!sel || sel.rangeCount === 0) return '';
  const range    = sel.getRangeAt(0);
  const preRange = document.createRange();
  preRange.selectNodeContents(editorEl);
  preRange.setEnd(range.startContainer, range.startOffset);
  const text  = preRange.toString();
  const match = text.match(/[a-zA-Z_$][a-zA-Z0-9_$]*$/);
  return match ? match[0] : '';
}

/** 補完候補ポップアップを表示する */
function showAutocomplete() {
  const word = getCurrentWord();
  if (word.length < 2) { hideAutocomplete(); return; }

  const matches = JS_KEYWORDS.filter(
    kw => kw.startsWith(word) && kw !== word
  );
  if (matches.length === 0) { hideAutocomplete(); return; }

  state.acMatches = matches;
  state.acIndex   = 0;

  // カーソルのスクリーン座標を取得
  const sel = window.getSelection();
  if (!sel || sel.rangeCount === 0) return;
  const rect = sel.getRangeAt(0).getBoundingClientRect();

  // ポップアップを描画
  acPopup.innerHTML = matches.map((m, i) =>
    `<div class="ac-item${i === 0 ? ' selected' : ''}"
          data-index="${i}"
          onmousedown="applyAutocomplete(${i})">${m}</div>`
  ).join('');

  acPopup.style.left = `${rect.left}px`;
  acPopup.style.top  = `${rect.bottom + 2}px`;
  acPopup.classList.remove('hidden');
}

/** 補完候補の選択を上下に移動する */
function moveAc(dir) {
  const items = acPopup.querySelectorAll('.ac-item');
  if (items.length === 0) return;
  items[state.acIndex]?.classList.remove('selected');
  state.acIndex = (state.acIndex + dir + items.length) % items.length;
  items[state.acIndex]?.classList.add('selected');
  items[state.acIndex]?.scrollIntoView({ block: 'nearest' });
}

/** 選択中の補完候補をエディタに適用する */
function applyAutocomplete(index = state.acIndex) {
  const word  = getCurrentWord();
  const chosen = state.acMatches[index];
  if (!chosen) { hideAutocomplete(); return; }

  // カーソル直前の単語を補完候補で置き換える
  const sel = window.getSelection();
  if (!sel || sel.rangeCount === 0) return;
  const range = sel.getRangeAt(0);
  range.setStart(range.startContainer, range.startOffset - word.length);
  sel.removeAllRanges();
  sel.addRange(range);
  insertText(chosen);
  hideAutocomplete();
}

/** 補完ポップアップを非表示にする */
function hideAutocomplete() {
  acPopup.classList.add('hidden');
  state.acMatches = [];
  state.acIndex   = -1;
}

// ============================================================
// 検索機能
// ============================================================

function openSearch() {
  searchBar.classList.remove('hidden');
  searchInput.focus();
  searchInput.select();
}

function closeSearch() {
  searchBar.classList.add('hidden');
  clearSearchHighlights();
  state.searchResults = [];
  state.searchIndex   = -1;
  searchCount.textContent = '';
  editorEl.focus();
}

/**
 * エディタ内を検索してすべての一致箇所を mark タグでハイライトする。
 * 検索結果を state.searchResults に格納する。
 */
function doSearch() {
  clearSearchHighlights();
  const query = searchInput.value;
  if (!query) { searchCount.textContent = ''; return; }

  const code  = getCode();
  const regex = new RegExp(escapeRegex(query), 'gi');
  let match;
  state.searchResults = [];
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
  state.searchIndex =
    (state.searchIndex + 1) % state.searchResults.length;
  scrollToResult(state.searchIndex);
}

function findPrev() {
  doSearch();
  if (state.searchResults.length === 0) return;
  state.searchIndex =
    (state.searchIndex - 1 + state.searchResults.length)
    % state.searchResults.length;
  scrollToResult(state.searchIndex);
}

/** 指定インデックスの検索結果にスクロールしてカーソルを移動する */
function scrollToResult(idx) {
  // 簡易実装: 検索結果の行にスクロール
  const pos   = state.searchResults[idx];
  const code  = getCode();
  const lines = code.substring(0, pos).split('\n');
  const lineNo = lines.length;
  const lineEls = lineNumEl.textContent.split('\n');
  // 行番号エリアの高さから概算スクロール位置を計算
  const lineH = 13 * 1.6; // font-size * line-height
  document.getElementById('editor-wrap').scrollTop = (lineNo - 3) * lineH;
}

function clearSearchHighlights() {
  // 検索ハイライトは視覚的にのみ表示（DOM 操作なし）
}

function escapeRegex(str) {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// ============================================================
// コメントアウト
// ============================================================

function toggleComment() {
  const code  = getCode();
  const sel   = saveSelection(editorEl);
  if (!sel) return;

  const lines     = code.split('\n');
  const startLine = code.substring(0, sel.start).split('\n').length - 1;
  const endLine   = code.substring(0, sel.end).split('\n').length - 1;

  // 選択範囲の全行が // で始まっているか確認
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

  setEditorText(newLines.join('\n'));
}

// ============================================================
// インデント整形
// ============================================================

function autoIndent() {
  const lines  = getCode().split('\n');
  const result = [];
  let depth    = 0;
  const indent = '    ';

  for (const line of lines) {
    const stripped = line.trim();
    if (!stripped) { result.push(''); continue; }

    // 閉じ括弧で始まる行はインデントを先に減らす
    if (/^[}\])]/.test(stripped)) depth = Math.max(0, depth - 1);

    result.push(indent.repeat(depth) + stripped);

    // 開き括弧の数 - 閉じ括弧の数 でインデント深度を更新
    const opens  = (stripped.match(/[{[(]/g) || []).length;
    const closes = (stripped.match(/[}\])]/g) || []).length;
    depth = Math.max(0, depth + opens - closes);
  }

  setEditorText(result.join('\n'));
  setStatusMsg('インデントを整形しました');
}

// ============================================================
// Undo / Redo
// ============================================================

/** ブラウザ組み込みの Undo を使用 */
function editorUndo() { document.execCommand('undo'); }
function editorRedo() { document.execCommand('redo'); }

// ============================================================
// ファイル操作
// ============================================================

function newFile() {
  if (state.isModified &&
      !confirm('変更を破棄して新規作成しますか？')) return;
  setEditorText('');
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
    setEditorText(ev.target.result);
    state.currentFileName = file.name;
    state.isModified      = false;
    updateTitle();
    setStatusMsg(`ファイルを開きました: ${file.name}`);
  };
  reader.readAsText(file, 'UTF-8');
  e.target.value = '';  // 同じファイルを再度選択できるようにリセット
}

function saveFile() {
  const code = getCode();
  const blob = new Blob([code], { type: 'text/javascript;charset=utf-8' });
  const url  = URL.createObjectURL(blob);
  const a    = document.createElement('a');
  a.href     = url;
  a.download = state.currentFileName;
  a.click();
  URL.revokeObjectURL(url);
  state.isModified = false;
  updateTitle();
  setStatusMsg(`保存しました: ${state.currentFileName}`);
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
  const current = parseFloat(
    getComputedStyle(editorEl).fontSize
  );
  const next = Math.min(32, Math.max(8, current + delta));
  editorEl.style.fontSize      = `${next}px`;
  lineNumEl.style.fontSize     = `${next}px`;
  outputEl.style.fontSize      = `${next}px`;
}

// ============================================================
// ステータスバー・タイトル更新
// ============================================================

function updateStatusPos() {
  const { line, col } = getCursorPosition();
  statusPos.textContent = `行: ${line}  列: ${col}`;
}

let statusTimer = null;
function setStatusMsg(msg) {
  statusMsg.textContent = msg;
  clearTimeout(statusTimer);
  statusTimer = setTimeout(() => {
    statusMsg.textContent = '準備完了';
  }, 3000);
}

function updateTitle() {
  const prefix = state.isModified ? '● ' : '';
  document.title = `${prefix}JS Editor - ${state.currentFileName}`;
}

function setRunStatus(text, cls) {
  runStatus.textContent = `● ${text}`;
  runStatus.className   = cls;
}

// ============================================================
// リサイズハンドル（上下ドラッグでエディタ/出力パネルの高さを変更）
// ============================================================

function initResizer() {
  const resizer    = document.getElementById('resizer');
  const editorPane = document.getElementById('editor-pane');
  const outputPane = document.getElementById('output-pane');
  let   startY, startEditorH, startOutputH;

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
    const newEditorH = Math.max(80, startEditorH + dy);
    const newOutputH = Math.max(80, startOutputH - dy);
    editorPane.style.flex = `0 0 ${newEditorH}px`;
    outputPane.style.flex = `0 0 ${newOutputH}px`;
  }

  function onMouseUp() {
    document.removeEventListener('mousemove', onMouseMove);
    document.removeEventListener('mouseup',   onMouseUp);
  }
}

// ============================================================
// ★ 実行エンジン
//   eval() を使ってブラウザ上で JS を実行する。
//   console.log 等をオーバーライドして出力をキャプチャする。
//   async/await・Promise・setTimeout に対応。
//   疑似 readline（stdin 入力待ち）にも対応。
// ============================================================

function runCode() {
  if (state.isRunning) { stopCode(); return; }

  const code = getCode().trim();
  if (!code) { appendOutput('⚠ コードが空です。\n', 'out-warning'); return; }

  clearOutput();
  state.isRunning     = false;
  state.stopRequested = false;
  state.stdinQueue    = [];
  state.stdinResolvers = [];

  appendOutput('▶ 実行開始\n', 'out-info');
  setRunStatus('実行中', 'status-running');
  state.isRunning = true;

  // --- console メソッドをオーバーライドしてキャプチャ ---
  const origConsole = {
    log:   console.log.bind(console),
    warn:  console.warn.bind(console),
    error: console.error.bind(console),
    info:  console.info.bind(console),
    table: console.table.bind(console),
  };

  /** 値を読みやすい文字列に変換する */
  function stringify(val) {
    if (val === null)      return 'null';
    if (val === undefined) return 'undefined';
    if (typeof val === 'object') {
      try { return JSON.stringify(val, null, 2); }
      catch { return String(val); }
    }
    return String(val);
  }

  console.log   = (...args) => { appendOutput(args.map(stringify).join(' ') + '\n', 'out-stdout'); origConsole.log(...args); };
  console.warn  = (...args) => { appendOutput('⚠ ' + args.map(stringify).join(' ') + '\n', 'out-warning'); origConsole.warn(...args); };
  console.error = (...args) => { appendOutput('✖ ' + args.map(stringify).join(' ') + '\n', 'out-stderr'); origConsole.error(...args); };
  console.info  = (...args) => { appendOutput('ℹ ' + args.map(stringify).join(' ') + '\n', 'out-info'); origConsole.info(...args); };
  console.table = (data)    => { appendOutput(tableToString(data) + '\n', 'out-stdout'); origConsole.table(data); };

  /**
   * 疑似 readline 関数。
   * stdin 入力欄から入力を受け取るまで Promise で待機する。
   * Node.js の readline のようにブラウザ上で入力待ちを実現する。
   */
  function readline(prompt = '') {
    if (prompt) appendOutput(prompt, 'out-info');
    return new Promise((resolve) => {
      // すでにキューに入力があれば即座に返す
      if (state.stdinQueue.length > 0) {
        resolve(state.stdinQueue.shift());
        return;
      }
      // なければ resolver を登録して入力を待つ
      state.stdinResolvers.push(resolve);
    });
  }

  /** console.table の簡易テキスト変換 */
  function tableToString(data) {
    if (!Array.isArray(data) || data.length === 0) return String(data);
    const keys = Object.keys(data[0]);
    const header = keys.join(' | ');
    const sep    = keys.map(k => '-'.repeat(k.length)).join('-+-');
    const rows   = data.map(row => keys.map(k => String(row[k] ?? '')).join(' | '));
    return [header, sep, ...rows].join('\n');
  }

  // --- コードを非同期関数でラップして実行 ---
  // async/await・return・トップレベル await に対応するため
  // AsyncFunction コンストラクタを使う
  const AsyncFunction = Object.getPrototypeOf(async function(){}).constructor;

  let execPromise;
  try {
    // readline と console をスコープに注入
    const fn = new AsyncFunction('readline', code);
    execPromise = fn(readline);
  } catch (err) {
    // 構文エラーは即座にキャッチ
    appendOutput(`✖ 構文エラー: ${err.message}\n`, 'out-stderr');
    finishRun(false);
    return;
  }

  // 実行結果を Promise で受け取る
  execPromise
    .then(() => {
      if (!state.stopRequested) {
        appendOutput('\n✅ 正常終了\n', 'out-success');
        finishRun(true);
      }
    })
    .catch((err) => {
      appendOutput(`\n✖ 実行エラー: ${err.message}\n`, 'out-stderr');
      finishRun(false);
    })
    .finally(() => {
      // console を元に戻す
      Object.assign(console, origConsole);
    });
}

/** 実行終了時の後処理 */
function finishRun(success) {
  state.isRunning      = false;
  state.stdinResolvers = [];
  state.stdinQueue     = [];
  setRunStatus(
    success ? '完了' : 'エラー',
    success ? 'status-done' : 'status-error'
  );
}

/** 実行を停止する */
function stopCode() {
  if (!state.isRunning) {
    setRunStatus('待機中', 'status-idle');
    return;
  }
  state.stopRequested = true;
  state.isRunning     = false;
  // 待機中の stdin resolver を空文字で解決して Promise を終了させる
  state.stdinResolvers.forEach(r => r(''));
  state.stdinResolvers = [];
  appendOutput('\n⏹ 実行を停止しました。\n', 'out-warning');
  setRunStatus('停止', 'status-stopped');
}

/** 出力パネルをクリアする */
function clearOutput() {
  outputEl.innerHTML = '';
  setRunStatus('待機中', 'status-idle');
}

/**
 * 出力パネルにテキストを追記する。
 * cls で文字色を切り替える（out-stdout / out-stderr / out-info 等）。
 */
function appendOutput(text, cls = 'out-stdout') {
  const span = document.createElement('span');
  span.className   = cls;
  span.textContent = text;
  outputEl.appendChild(span);
  outputEl.scrollTop = outputEl.scrollHeight;  // 常に最新行を表示
}

/**
 * stdin 入力欄の内容を実行中の readline() に送信する。
 * stdinResolvers に待機中の Promise があれば即座に解決する。
 */
function sendStdin() {
  const text = stdinInput.value.trim();
  stdinInput.value = '';
  appendOutput(`> ${text}\n`, 'out-info');

  if (state.stdinResolvers.length > 0) {
    // 待機中の readline() を解決する
    const resolve = state.stdinResolvers.shift();
    resolve(text);
  } else {
    // 待機中がなければキューに積んでおく
    state.stdinQueue.push(text);
  }
}
