# ============================================================
# js_editor.py
# JavaScript 高性能エディタ + 実行シミュレータ
# 動作環境 : Ubuntu / Python 3.10+
# 依存ライブラリ: pygments (pip install pygments)
#               tkinter  (sudo apt install python3-tk)
#               Node.js  (sudo apt install nodejs)
# 起動方法 : python3 js_editor.py
# ============================================================

import tkinter as tk
from tkinter import ttk, filedialog, messagebox, font
# pygments : シンタックスハイライト用ライブラリ
from pygments import lex
from pygments.lexers import JavascriptLexer
from pygments.token import Token
import os
import re
import subprocess   # Node.js プロセスの起動・制御に使用
import threading    # 実行を別スレッドで行い UI をブロックしないために使用
import tempfile     # コード実行用の一時ファイル作成に使用


# ============================================================
# JSEditor クラス
#   アプリケーション全体を管理するメインクラス。
#   UI の構築・イベント処理・ファイル操作・実行制御を担う。
# ============================================================
class JSEditor:

    def __init__(self, root):
        """
        アプリケーションの初期化。
        ウィンドウ設定・テーマ定義・UI構築・ショートカット登録を行う。
        """
        self.root = root
        self.root.title("JS Editor - Untitled")
        self.root.geometry("1200x900")
        self.root.configure(bg="#1e1e2e")

        # --- 状態管理変数 ---
        self.current_file        = None   # 現在開いているファイルのパス
        self.is_modified         = False  # 未保存の変更があるか
        self._highlight_timer    = None   # シンタックスハイライトの遅延タイマー
        self._autocomplete_timer = None   # 自動補完の遅延タイマー
        self._run_process        = None   # 実行中の Node.js プロセス
        self.undo_stack          = []     # Undo 履歴（将来の拡張用）
        self.redo_stack          = []     # Redo 履歴（将来の拡張用）

        # --- カラーテーマ (Catppuccin Mocha 風ダークテーマ) ---
        self.theme = {
            "bg":        "#1e1e2e",  # エディタ背景
            "fg":        "#cdd6f4",  # 通常テキスト
            "line_bg":   "#181825",  # 行番号エリア背景
            "line_fg":   "#6c7086",  # 行番号テキスト
            "cursor":    "#f5c2e7",  # カーソル色
            "select_bg": "#313244",  # 選択範囲背景
            "status_bg": "#313244",  # ステータスバー背景
            "status_fg": "#cdd6f4",  # ステータスバーテキスト
            "border":    "#45475a",  # ボーダー・ボタン背景
        }

        # --- シンタックスハイライト用カラー定義 ---
        # Token の種類ごとに表示色を割り当てる
        self.syntax_colors = {
            Token.Keyword:             "#cba6f7",  # キーワード (if/for/const等) → 紫
            Token.Keyword.Declaration: "#cba6f7",  # 宣言キーワード (let/var等)  → 紫
            Token.Keyword.Reserved:    "#cba6f7",  # 予約語                      → 紫
            Token.Name.Builtin:        "#89dceb",  # 組み込みオブジェクト        → 水色
            Token.Name.Function:       "#89b4fa",  # 関数名                      → 青
            Token.Name.Class:          "#f9e2af",  # クラス名                    → 黄
            Token.String:              "#a6e3a1",  # 文字列全般                  → 緑
            Token.String.Double:       "#a6e3a1",  # ダブルクォート文字列        → 緑
            Token.String.Single:       "#a6e3a1",  # シングルクォート文字列      → 緑
            Token.String.Backtick:     "#a6e3a1",  # テンプレートリテラル        → 緑
            Token.Comment:             "#6c7086",  # コメント全般                → グレー
            Token.Comment.Single:      "#6c7086",  # 一行コメント (//)           → グレー
            Token.Comment.Multiline:   "#6c7086",  # 複数行コメント (/* */)      → グレー
            Token.Number:              "#fab387",  # 数値全般                    → オレンジ
            Token.Number.Integer:      "#fab387",  # 整数                        → オレンジ
            Token.Number.Float:        "#fab387",  # 浮動小数点数                → オレンジ
            Token.Operator:            "#89dceb",  # 演算子 (+ - * / 等)         → 水色
            Token.Punctuation:         "#cdd6f4",  # 記号 (; , . 等)             → デフォルト
            Token.Name:                "#cdd6f4",  # 変数名・識別子              → デフォルト
            Token.Text:                "#cdd6f4",  # その他テキスト              → デフォルト
        }

        # UI 構築・ショートカット登録・補完初期化
        self._build_ui()
        self._bind_shortcuts()
        self._setup_autocomplete()


    # ==========================================================
    # UI 構築メソッド群
    # ==========================================================

    def _build_ui(self):
        """UI 全体を組み立てる。各パーツを順番に構築する。"""
        self._build_menu()       # メニューバー
        self._build_toolbar()    # ツールバー
        self._build_main_area()  # エディタ + 出力パネル
        self._build_statusbar()  # ステータスバー

    def _build_menu(self):
        """メニューバーを構築する（ファイル・編集・実行・表示）。"""
        menubar = tk.Menu(
            self.root,
            bg=self.theme["status_bg"], fg=self.theme["fg"],
            activebackground=self.theme["select_bg"],
            activeforeground=self.theme["fg"], relief="flat",
        )

        # ---- ファイルメニュー ----
        file_menu = tk.Menu(
            menubar, tearoff=0,
            bg=self.theme["status_bg"], fg=self.theme["fg"],
            activebackground=self.theme["select_bg"],
            activeforeground=self.theme["fg"],
        )
        file_menu.add_command(label="新規作成          Ctrl+N", command=self.new_file)
        file_menu.add_command(label="開く              Ctrl+O", command=self.open_file)
        file_menu.add_separator()
        file_menu.add_command(label="保存              Ctrl+S", command=self.save_file)
        file_menu.add_command(
            label="名前を付けて保存  Ctrl+Shift+S", command=self.save_as_file
        )
        file_menu.add_separator()
        file_menu.add_command(label="終了              Ctrl+Q", command=self.quit_app)
        menubar.add_cascade(label="ファイル", menu=file_menu)

        # ---- 編集メニュー ----
        edit_menu = tk.Menu(
            menubar, tearoff=0,
            bg=self.theme["status_bg"], fg=self.theme["fg"],
            activebackground=self.theme["select_bg"],
            activeforeground=self.theme["fg"],
        )
        edit_menu.add_command(label="元に戻す          Ctrl+Z", command=self.undo)
        edit_menu.add_command(label="やり直し          Ctrl+Y", command=self.redo)
        edit_menu.add_separator()
        edit_menu.add_command(label="検索              Ctrl+F", command=self.open_search)
        edit_menu.add_command(label="置換              Ctrl+H", command=self.open_replace)
        edit_menu.add_separator()
        edit_menu.add_command(
            label="コメントアウト    Ctrl+/", command=self.toggle_comment
        )
        edit_menu.add_command(
            label="インデント整形    Ctrl+I", command=self.auto_indent
        )
        menubar.add_cascade(label="編集", menu=edit_menu)

        # ---- 実行メニュー ----
        run_menu = tk.Menu(
            menubar, tearoff=0,
            bg=self.theme["status_bg"], fg=self.theme["fg"],
            activebackground=self.theme["select_bg"],
            activeforeground=self.theme["fg"],
        )
        run_menu.add_command(label="実行              F5", command=self.run_code)
        run_menu.add_command(label="停止              F6", command=self.stop_code)
        run_menu.add_command(label="出力をクリア      F7", command=self.clear_output)
        menubar.add_cascade(label="実行", menu=run_menu)

        # ---- 表示メニュー ----
        view_menu = tk.Menu(
            menubar, tearoff=0,
            bg=self.theme["status_bg"], fg=self.theme["fg"],
            activebackground=self.theme["select_bg"],
            activeforeground=self.theme["fg"],
        )
        view_menu.add_command(
            label="フォントサイズ +  Ctrl++",
            command=lambda: self.change_font_size(1)
        )
        view_menu.add_command(
            label="フォントサイズ -  Ctrl+-",
            command=lambda: self.change_font_size(-1)
        )
        menubar.add_cascade(label="表示", menu=view_menu)

        self.root.config(menu=menubar)

    def _build_toolbar(self):
        """ツールバーを構築する。よく使う操作をボタンで並べる。"""
        toolbar = tk.Frame(
            self.root, bg=self.theme["status_bg"], height=36, pady=4
        )
        toolbar.pack(side=tk.TOP, fill=tk.X)

        # ボタン共通スタイル
        btn_style = {
            "bg":     self.theme["border"],
            "fg":     self.theme["fg"],
            "relief": "flat",
            "padx":   10,
            "pady":   2,
            "cursor": "hand2",
            "font":   ("Sans", 9),
        }

        # (表示ラベル, コマンド) のリスト。"|" はセパレータ
        buttons = [
            ("📄 新規",     self.new_file),
            ("📂 開く",     self.open_file),
            ("💾 保存",     self.save_file),
            ("|",           None),
            ("↩ 元に戻す", self.undo),
            ("↪ やり直し", self.redo),
            ("|",           None),
            ("🔍 検索",     self.open_search),
            ("🔁 置換",     self.open_replace),
            ("|",           None),
            ("💬 コメント", self.toggle_comment),
            ("✨ 整形",     self.auto_indent),
            ("|",           None),
            ("▶ 実行",      self.run_code),   # 緑色で目立たせる
            ("■ 停止",      self.stop_code),  # 赤色で目立たせる
            ("🗑 クリア",   self.clear_output),
        ]

        for label, cmd in buttons:
            if label == "|":
                # セパレータ（縦線）
                tk.Label(
                    toolbar, text="│",
                    bg=self.theme["status_bg"], fg=self.theme["border"],
                ).pack(side=tk.LEFT, padx=2)
            else:
                style = dict(btn_style)
                # 実行・停止ボタンは色を変えて視認性を上げる
                if label == "▶ 実行":
                    style["bg"] = "#40a02b"  # 緑
                elif label == "■ 停止":
                    style["bg"] = "#d20f39"  # 赤

                btn = tk.Button(toolbar, text=label, command=cmd, **style)
                btn.pack(side=tk.LEFT, padx=2)

                # ホバー時に色を変えるアニメーション
                orig_bg = style["bg"]
                btn.bind("<Enter>",
                         lambda e, b=btn: b.config(bg=self.theme["select_bg"]))
                btn.bind("<Leave>",
                         lambda e, b=btn, c=orig_bg: b.config(bg=c))

    def _build_main_area(self):
        """
        メインエリアを構築する。
        上段: コードエディタ（行番号付き）
        下段: 実行出力パネル（stdin 入力欄付き）
        PanedWindow でドラッグによるサイズ変更が可能。
        """
        # 上下に分割できるペイン
        self.paned = tk.PanedWindow(
            self.root, orient=tk.VERTICAL,
            bg=self.theme["border"], sashwidth=5, sashrelief="flat",
        )
        self.paned.pack(fill=tk.BOTH, expand=True)

        # ── 上段: エディタペイン ──────────────────────────
        editor_pane = tk.Frame(self.paned, bg=self.theme["bg"])
        self.paned.add(editor_pane, minsize=200)  # 最小高さ 200px

        main_frame = tk.Frame(editor_pane, bg=self.theme["bg"])
        main_frame.pack(fill=tk.BOTH, expand=True)

        # --- 行番号エリア ---
        # エディタ左側に固定幅で配置し、スクロールをエディタと同期させる
        self.line_frame = tk.Frame(
            main_frame, bg=self.theme["line_bg"], width=50
        )
        self.line_frame.pack(side=tk.LEFT, fill=tk.Y)
        self.line_frame.pack_propagate(False)  # 幅を固定

        self.line_numbers = tk.Text(
            self.line_frame,
            width=5, padx=6, pady=8,
            bg=self.theme["line_bg"], fg=self.theme["line_fg"],
            font=("Monospace", 12),
            state=tk.DISABLED,    # 直接編集不可
            relief="flat",
            cursor="arrow",       # カーソルを矢印に（テキスト選択を抑制）
            selectbackground=self.theme["line_bg"],
        )
        self.line_numbers.pack(fill=tk.BOTH, expand=True)

        # --- エディタ本体 ---
        editor_frame = tk.Frame(main_frame, bg=self.theme["bg"])
        editor_frame.pack(side=tk.LEFT, fill=tk.BOTH, expand=True)

        # 縦横スクロールバー
        v_scroll = ttk.Scrollbar(editor_frame, orient=tk.VERTICAL)
        v_scroll.pack(side=tk.RIGHT, fill=tk.Y)
        h_scroll = ttk.Scrollbar(editor_frame, orient=tk.HORIZONTAL)
        h_scroll.pack(side=tk.BOTTOM, fill=tk.X)

        # メインのテキストエディタウィジェット
        self.editor = tk.Text(
            editor_frame,
            bg=self.theme["bg"], fg=self.theme["fg"],
            insertbackground=self.theme["cursor"],   # カーソルの色
            selectbackground=self.theme["select_bg"],
            font=("Monospace", 12),
            padx=8, pady=8,
            relief="flat",
            wrap=tk.NONE,        # 折り返しなし（横スクロール対応）
            undo=True,           # Tkinter 組み込みの Undo/Redo を有効化
            maxundo=200,         # Undo 履歴の最大数
            yscrollcommand=self._sync_scroll,  # 行番号と同期
            xscrollcommand=h_scroll.set,
            tabs=("4c",),        # タブ幅を4文字分に設定
        )
        self.editor.pack(fill=tk.BOTH, expand=True)

        # スクロールバーとエディタを接続
        v_scroll.config(command=self._on_vscroll)
        h_scroll.config(command=self.editor.xview)

        # --- シンタックスハイライト用タグを登録 ---
        # タグ名は Token オブジェクトを文字列化したもの ("Token.Keyword" 等)
        for token, color in self.syntax_colors.items():
            self.editor.tag_config(str(token), foreground=color)

        # 現在行をうっすらハイライトするタグ
        self.editor.tag_config("current_line", background="#2a2a3e")

        # 対応する括弧をハイライトするタグ
        self.editor.tag_config(
            "bracket_match", background="#3d5a80", foreground="#ffffff"
        )

        # 検索結果をハイライトするタグ
        self.editor.tag_config(
            "search_highlight", background="#f9e2af", foreground="#1e1e2e"
        )

        # エラー発生行をハイライトするタグ（Node.js のエラー出力から行番号を取得）
        self.editor.tag_config(
            "error_line", background="#3d1a1a", foreground="#f38ba8"
        )

        # --- キーボード・マウスイベントのバインド ---
        self.editor.bind("<KeyRelease>",    self._on_key_release)
        self.editor.bind("<ButtonRelease>", self._on_cursor_move)
        self.editor.bind("<Return>",        self._on_enter)
        self.editor.bind("<Tab>",           self._on_tab)
        self.editor.bind("<BackSpace>",     self._on_backspace)
        # 括弧・引用符を入力したとき自動で閉じ括弧を挿入
        self.editor.bind("(",  lambda e: self._auto_close("(", ")"))
        self.editor.bind("[",  lambda e: self._auto_close("[", "]"))
        self.editor.bind("{",  lambda e: self._auto_close("{", "}"))
        self.editor.bind('"',  lambda e: self._auto_close('"', '"'))
        self.editor.bind("'",  lambda e: self._auto_close("'", "'"))
        self.editor.bind("`",  lambda e: self._auto_close("`", "`"))

        # 初期表示の行番号を描画
        self._update_line_numbers()

        # ── 下段: 出力パネル ─────────────────────────────
        output_pane = tk.Frame(self.paned, bg=self.theme["line_bg"])
        self.paned.add(output_pane, minsize=120)  # 最小高さ 120px

        # 出力パネルのヘッダーバー
        output_header = tk.Frame(
            output_pane, bg=self.theme["status_bg"], height=28
        )
        output_header.pack(side=tk.TOP, fill=tk.X)
        output_header.pack_propagate(False)

        tk.Label(
            output_header, text="▼ 出力 / コンソール",
            bg=self.theme["status_bg"], fg=self.theme["fg"],
            font=("Sans", 9, "bold"), padx=10,
        ).pack(side=tk.LEFT, pady=4)

        # 実行ステータスラベル（待機中 / 実行中 / 完了 / エラー / 停止）
        self.run_status = tk.Label(
            output_header, text="●  待機中",
            bg=self.theme["status_bg"], fg=self.theme["line_fg"],
            font=("Sans", 9), padx=10,
        )
        self.run_status.pack(side=tk.RIGHT, pady=4)

        # 出力テキストエリア本体
        out_frame = tk.Frame(output_pane, bg=self.theme["line_bg"])
        out_frame.pack(fill=tk.BOTH, expand=True)

        out_scroll = ttk.Scrollbar(out_frame, orient=tk.VERTICAL)
        out_scroll.pack(side=tk.RIGHT, fill=tk.Y)

        self.output = tk.Text(
            out_frame,
            bg="#11111b", fg="#cdd6f4",
            insertbackground=self.theme["cursor"],
            font=("Monospace", 11),
            padx=10, pady=8,
            relief="flat",
            wrap=tk.WORD,        # 長い行は折り返して表示
            state=tk.DISABLED,   # ユーザーが直接編集できないようにする
            yscrollcommand=out_scroll.set,
        )
        self.output.pack(fill=tk.BOTH, expand=True)
        out_scroll.config(command=self.output.yview)

        # 出力テキストの種類ごとに色を設定するタグ
        self.output.tag_config("stdout",    foreground="#cdd6f4")  # 通常出力
        self.output.tag_config("stderr",    foreground="#f38ba8")  # エラー出力 → 赤
        self.output.tag_config("info",      foreground="#89b4fa")  # 情報メッセージ → 青
        self.output.tag_config("success",   foreground="#a6e3a1")  # 成功メッセージ → 緑
        self.output.tag_config("warning",   foreground="#f9e2af")  # 警告メッセージ → 黄
        self.output.tag_config("timestamp", foreground="#6c7086")  # タイムスタンプ → グレー

        # stdin 入力エリア（実行中プロセスへ文字列を送信できる）
        input_frame = tk.Frame(
            output_pane, bg=self.theme["status_bg"], height=32
        )
        input_frame.pack(side=tk.BOTTOM, fill=tk.X)
        input_frame.pack_propagate(False)

        tk.Label(
            input_frame, text="stdin >",
            bg=self.theme["status_bg"], fg=self.theme["line_fg"],
            font=("Monospace", 10), padx=8,
        ).pack(side=tk.LEFT, pady=4)

        self.stdin_var = tk.StringVar()
        self.stdin_entry = tk.Entry(
            input_frame,
            textvariable=self.stdin_var,
            bg="#313244", fg=self.theme["fg"],
            insertbackground=self.theme["cursor"],
            relief="flat", font=("Monospace", 10),
        )
        self.stdin_entry.pack(side=tk.LEFT, fill=tk.X, expand=True, pady=4)
        # Enter キーで送信できるようにバインド
        self.stdin_entry.bind("<Return>", self._send_stdin)

        tk.Button(
            input_frame, text="送信",
            command=self._send_stdin,
            bg=self.theme["border"], fg=self.theme["fg"],
            relief="flat", padx=8, cursor="hand2", font=("Sans", 9),
        ).pack(side=tk.LEFT, padx=4, pady=4)

    def _build_statusbar(self):
        """ウィンドウ下部のステータスバーを構築する。"""
        self.status_bar = tk.Frame(
            self.root, bg=self.theme["status_bg"], height=24
        )
        self.status_bar.pack(side=tk.BOTTOM, fill=tk.X)

        # 左側: 言語・エンコーディング表示
        self.status_left = tk.Label(
            self.status_bar, text="JavaScript  |  UTF-8",
            bg=self.theme["status_bg"], fg=self.theme["status_fg"],
            font=("Sans", 9), padx=10,
        )
        self.status_left.pack(side=tk.LEFT)

        # 右側: カーソル位置（行・列）
        self.status_right = tk.Label(
            self.status_bar, text="行: 1  列: 1",
            bg=self.theme["status_bg"], fg=self.theme["status_fg"],
            font=("Sans", 9), padx=10,
        )
        self.status_right.pack(side=tk.RIGHT)

        # 中央右寄り: 操作結果メッセージ（3秒後に「準備完了」に戻る）
        self.status_msg = tk.Label(
            self.status_bar, text="準備完了",
            bg=self.theme["status_bg"], fg="#a6e3a1",
            font=("Sans", 9), padx=10,
        )
        self.status_msg.pack(side=tk.RIGHT)


    # ==========================================================
    # スクロール同期
    # ==========================================================

    def _sync_scroll(self, *args):
        """
        エディタの縦スクロールに合わせて行番号エリアも同期させる。
        yscrollcommand に登録して使う。
        """
        self.line_numbers.yview_moveto(args[0])

    def _on_vscroll(self, *args):
        """
        縦スクロールバー操作時にエディタと行番号を同時にスクロールする。
        """
        self.editor.yview(*args)
        self.line_numbers.yview(*args)


    # ==========================================================
    # 行番号の更新
    # ==========================================================

    def _update_line_numbers(self):
        """
        エディタの総行数に合わせて行番号エリアを再描画する。
        キー入力のたびに呼ばれるため、軽量に保つこと。
        """
        self.line_numbers.config(state=tk.NORMAL)
        self.line_numbers.delete("1.0", tk.END)
        # エディタの最終行番号を取得して 1〜N の番号を生成
        total = int(self.editor.index(tk.END).split(".")[0])
        self.line_numbers.insert("1.0", "\n".join(str(i) for i in range(1, total)))
        self.line_numbers.config(state=tk.DISABLED)


    # ==========================================================
    # シンタックスハイライト
    # ==========================================================

    def _highlight_syntax(self):
        """
        Pygments を使ってエディタ全体のシンタックスハイライトを適用する。
        処理が重いため、キー入力から 300ms 遅延して呼び出す（デバウンス）。
        """
        code = self.editor.get("1.0", tk.END)

        # 既存のハイライトタグをすべて除去してから再適用
        for token in self.syntax_colors:
            self.editor.tag_remove(str(token), "1.0", tk.END)

        pos = 0
        for token, value in lex(code, JavascriptLexer()):
            start = self._offset_to_index(pos)
            end   = self._offset_to_index(pos + len(value))
            tag   = str(token)

            # 完全一致するタグがなければ親トークンにフォールバック
            # 例: Token.Keyword.Declaration → Token.Keyword
            if tag not in [str(t) for t in self.syntax_colors]:
                for t in self.syntax_colors:
                    if str(token).startswith(str(t)):
                        tag = str(t)
                        break

            if tag in [str(t) for t in self.syntax_colors]:
                self.editor.tag_add(tag, start, end)
            pos += len(value)

    def _offset_to_index(self, offset):
        """
        文字列の先頭からの文字オフセットを
        Tkinter の "行.列" 形式インデックスに変換する。
        """
        return self.editor.index(f"1.0 + {offset} chars")


    # ==========================================================
    # 現在行ハイライト
    # ==========================================================

    def _highlight_current_line(self):
        """
        カーソルがある行をうっすらハイライトする。
        キー入力・クリックのたびに即時呼び出す（軽い処理）。
        """
        self.editor.tag_remove("current_line", "1.0", tk.END)
        line = self.editor.index(tk.INSERT).split(".")[0]
        # 行頭から行末+改行文字まで範囲指定
        self.editor.tag_add("current_line", f"{line}.0", f"{line}.end+1c")


    # ==========================================================
    # 括弧マッチングハイライト
    # ==========================================================

    def _highlight_brackets(self):
        """
        カーソル位置の括弧と対応する括弧をハイライトする。
        カーソルの直前・直後の文字を両方チェックする。
        """
        self.editor.tag_remove("bracket_match", "1.0", tk.END)
        pairs = {
            "(": ")", "[": "]", "{": "}",  # 開き括弧 → 対応する閉じ括弧
            ")": "(", "]": "[", "}": "{",  # 閉じ括弧 → 対応する開き括弧
        }
        cursor_pos = self.editor.index(tk.INSERT)

        # カーソルの直後("")と直前("-1c")の文字を順にチェック
        for offset in ["", "-1c"]:
            try:
                char_pos = self.editor.index(f"{cursor_pos}{offset}")
                char     = self.editor.get(char_pos)
                if char in pairs:
                    match_pos = self._find_matching_bracket(
                        char_pos, char, pairs[char]
                    )
                    if match_pos:
                        # 見つかったペアを両方ハイライト
                        self.editor.tag_add(
                            "bracket_match", char_pos, f"{char_pos}+1c"
                        )
                        self.editor.tag_add(
                            "bracket_match", match_pos, f"{match_pos}+1c"
                        )
                    break  # 1文字見つかれば終了
            except tk.TclError:
                pass

    def _find_matching_bracket(self, pos, open_b, close_b):
        """
        指定した括弧の対応する括弧の位置を検索して返す。
        開き括弧なら前方向、閉じ括弧なら後ろ方向に走査する。
        ネストに対応するため depth カウンタを使う。

        Args:
            pos    : 検索開始位置 (Tkinter インデックス)
            open_b : 開始括弧の文字 (例: "(")
            close_b: 対応する括弧の文字 (例: ")")
        Returns:
            対応括弧の Tkinter インデックス、見つからなければ None
        """
        code    = self.editor.get("1.0", tk.END)
        index   = len(self.editor.get("1.0", pos))  # 文字オフセットに変換
        forward = open_b in "([{"  # 開き括弧なら前方向に検索
        depth   = 0
        rng     = range(index, len(code)) if forward else range(index, -1, -1)

        for i in rng:
            c = code[i]
            if c == (open_b if forward else close_b):
                depth += 1  # 同じ種類の括弧が増えたらネスト深度を増やす
            elif c == (close_b if forward else open_b):
                depth -= 1
                if depth == 0:
                    return self._offset_to_index(i)  # 対応括弧を発見
        return None  # 対応括弧が見つからなかった


    # ==========================================================
    # 自動補完
    # ==========================================================

    def _setup_autocomplete(self):
        """
        自動補完の初期設定。
        補完候補となる JavaScript キーワード・組み込み関数の一覧を定義する。
        """
        self.js_keywords = [
            # 制御構文・宣言
            "function", "const", "let", "var", "return", "if", "else",
            "for", "while", "do", "switch", "case", "break", "continue",
            # クラス・モジュール
            "class", "extends", "new", "this", "super", "import", "export",
            "default", "from",
            # 非同期・例外処理
            "async", "await", "try", "catch", "finally", "throw",
            # 型・値
            "typeof", "instanceof", "in", "of", "null", "undefined",
            "true", "false",
            # 組み込みオブジェクト
            "console", "document", "window", "Array", "Object", "String",
            "Number", "Boolean", "Promise", "Math", "JSON",
            # タイマー・非同期API
            "setTimeout", "setInterval", "clearTimeout", "fetch",
            # DOM操作
            "addEventListener", "querySelector", "getElementById",
            # 配列メソッド
            "forEach", "map", "filter", "reduce", "find", "includes",
            "push", "pop", "shift", "unshift", "splice", "slice", "join",
            # ユーティリティ
            "toString", "parseInt", "parseFloat", "isNaN", "isFinite",
        ]
        self.autocomplete_window  = None   # 補完候補ポップアップウィンドウ
        self._highlight_timer     = None   # ハイライト遅延タイマー
        self._autocomplete_timer  = None   # 補完遅延タイマー

    def _show_autocomplete(self):
        """
        カーソル位置の単語に一致する補完候補をポップアップ表示する。
        候補が変わらない場合は再描画しない（パフォーマンス最適化）。
        フォーカスはエディタに残したまま ↑↓ キーで候補を選択できる。
        """
        word = self._get_current_word()

        # 2文字未満は補完しない（誤作動防止）
        if len(word) < 2:
            self._hide_autocomplete()
            return

        # 前方一致で候補を絞り込む（入力中の単語自体は除外）
        matches = [kw for kw in self.js_keywords
                   if kw.startswith(word) and kw != word]
        if not matches:
            self._hide_autocomplete()
            return

        # 候補リストが変わっていなければ再描画をスキップ
        if self.autocomplete_window:
            try:
                current = list(self.autocomplete_window.listbox.get(0, tk.END))
                if current == matches:
                    return
            except Exception:
                pass

        self._hide_autocomplete()

        # カーソルのスクリーン座標を取得してポップアップ位置を決定
        try:
            bbox = self.editor.bbox(tk.INSERT)
            if not bbox:
                return
            x, y, _, h = bbox
        except Exception:
            return

        # エディタウィジェットのルート座標 + カーソル位置
        x += self.editor.winfo_rootx()
        y += self.editor.winfo_rooty() + h  # カーソルの下に表示

        # 装飾なしのトップレベルウィンドウとして表示
        self.autocomplete_window = tk.Toplevel(self.root)
        self.autocomplete_window.wm_overrideredirect(True)  # タイトルバーなし
        self.autocomplete_window.geometry(f"+{x}+{y}")
        self.autocomplete_window.wm_attributes("-topmost", True)  # 最前面に表示

        listbox = tk.Listbox(
            self.autocomplete_window,
            bg="#313244", fg="#cdd6f4",
            selectbackground="#89b4fa", selectforeground="#1e1e2e",
            font=("Monospace", 11),
            relief="flat", borderwidth=1,
            height=min(8, len(matches)),  # 最大8件表示
            width=25,
            takefocus=False,  # フォーカスをエディタから奪わない
        )
        listbox.pack()
        for m in matches:
            listbox.insert(tk.END, m)
        listbox.select_set(0)  # 最初の候補を選択状態にする

        def apply(event=None):
            """選択中の候補をエディタに挿入して補完ウィンドウを閉じる。"""
            sel = listbox.curselection()
            if sel:
                self._replace_current_word(listbox.get(sel[0]))
            self._hide_autocomplete()
            self.editor.focus_set()

        def select_next(event=None):
            """↓ キーで次の候補を選択する。"""
            sel = listbox.curselection()
            idx = (sel[0] + 1) % listbox.size() if sel else 0
            listbox.select_clear(0, tk.END)
            listbox.select_set(idx)
            return "break"

        def select_prev(event=None):
            """↑ キーで前の候補を選択する。"""
            sel = listbox.curselection()
            idx = (sel[0] - 1) % listbox.size() if sel else 0
            listbox.select_clear(0, tk.END)
            listbox.select_set(idx)
            return "break"

        # エディタ側でキー操作して補完を制御（フォーカスはエディタのまま）
        self.editor.bind("<Tab>",    lambda e: apply() or "break")
        self.editor.bind("<Return>", self._on_enter_with_autocomplete)
        self.editor.bind("<Down>",   lambda e: select_next())
        self.editor.bind("<Up>",     lambda e: select_prev())
        self.editor.bind("<Escape>", lambda e: self._hide_autocomplete())

        # ダブルクリックでも補完を適用できる
        listbox.bind("<Double-1>", apply)
        self.autocomplete_window.listbox = listbox  # 後から参照できるよう保持

    def _hide_autocomplete(self):
        """
        補完ウィンドウを閉じてエディタのキーバインドを元に戻す。
        補完表示中は ↑↓/Tab/Enter/Escape を上書きしているため、
        閉じるときに必ず元のバインドに戻す必要がある。
        """
        if self.autocomplete_window:
            try:
                self.autocomplete_window.destroy()
            except Exception:
                pass
            self.autocomplete_window = None

        # 上書きしたキーバインドを元に戻す
        self.editor.bind("<Tab>",    self._on_tab)
        self.editor.bind("<Return>", self._on_enter)
        self.editor.bind("<Down>",   lambda e: None)
        self.editor.bind("<Up>",     lambda e: None)
        self.editor.bind("<Escape>", lambda e: None)

    def _get_current_word(self):
        """
        カーソル直前の単語（識別子）を取得して返す。
        正規表現で JavaScript の識別子パターン [a-zA-Z_$][a-zA-Z0-9_$]* にマッチさせる。
        """
        cursor    = self.editor.index(tk.INSERT)
        line, col = map(int, cursor.split("."))
        # カーソルより左側のテキストを取得
        line_text = self.editor.get(f"{line}.0", f"{line}.{col}")
        match     = re.search(r"[a-zA-Z_$][a-zA-Z0-9_$]*$", line_text)
        return match.group(0) if match else ""

    def _replace_current_word(self, new_word):
        """
        カーソル直前の単語を補完候補で置き換える。
        _get_current_word() で取得した単語の範囲を削除して new_word を挿入する。
        """
        word      = self._get_current_word()
        cursor    = self.editor.index(tk.INSERT)
        line, col = map(int, cursor.split("."))
        start     = f"{line}.{col - len(word)}"
        self.editor.delete(start, cursor)
        self.editor.insert(start, new_word)


    # ==========================================================
    # キーボードイベントハンドラ
    # ==========================================================

    def _on_key_release(self, event):
        """
        キーを離したときに呼ばれるメインハンドラ。
        軽い処理（行ハイライト・行番号・ステータス）は即時実行し、
        重い処理（シンタックスハイライト・補完）はデバウンスで遅延実行する。
        """
        # 修飾キーやカーソル移動キーは処理をスキップ（無駄な再描画を防ぐ）
        if event.keysym in (
            "Shift_L", "Shift_R", "Control_L", "Control_R",
            "Alt_L", "Alt_R", "Super_L", "Super_R",
            "Up", "Down", "Left", "Right",
            "Home", "End", "Prior", "Next",
            "Caps_Lock", "Num_Lock",
        ):
            return

        # 軽い処理は即時実行
        self._highlight_current_line()
        self._highlight_brackets()
        self._update_line_numbers()
        self._update_status()
        self._mark_modified()

        # シンタックスハイライトは 300ms 後に実行（連続入力中は毎回リセット）
        if self._highlight_timer:
            self.root.after_cancel(self._highlight_timer)
        self._highlight_timer = self.root.after(300, self._highlight_syntax)

        # 補完が不要なキーは補完ウィンドウを閉じて終了
        if event.keysym in ("Return", "Tab", "Escape", "BackSpace",
                             "Delete", "space"):
            self._hide_autocomplete()
            return

        # 自動補完は 400ms 後に実行（連続入力中は毎回リセット）
        if self._autocomplete_timer:
            self.root.after_cancel(self._autocomplete_timer)
        self._autocomplete_timer = self.root.after(400, self._show_autocomplete)

    def _on_cursor_move(self, event):
        """マウスクリックでカーソルが移動したときに行ハイライト等を更新する。"""
        self._highlight_current_line()
        self._highlight_brackets()
        self._update_status()

    def _on_enter(self, event):
        """
        Enter キー処理: 改行 + 自動インデント。
        前の行のインデント量を引き継ぎ、{ で終わっていれば追加インデントする。
        """
        cursor    = self.editor.index(tk.INSERT)
        line      = int(cursor.split(".")[0])
        prev_line = self.editor.get(f"{line}.0", f"{line}.end")
        # 前の行の先頭スペース・タブを取得
        indent    = re.match(r"^(\s*)", prev_line).group(1)
        # { で終わっていれば1段深くインデント
        if prev_line.rstrip().endswith("{"):
            indent += "    "
        self.editor.insert(tk.INSERT, "\n" + indent)
        return "break"  # デフォルトの改行動作をキャンセル

    def _on_enter_with_autocomplete(self, event):
        """
        補完ウィンドウが表示されているときの Enter キー処理。
        補完候補を適用する。ウィンドウが閉じていれば通常の改行処理を行う。
        """
        if self.autocomplete_window:
            try:
                lb  = self.autocomplete_window.listbox
                sel = lb.curselection()
                if sel:
                    self._replace_current_word(lb.get(sel[0]))
                self._hide_autocomplete()
                self.editor.focus_set()
                return "break"
            except Exception:
                pass
        # 補完ウィンドウがなければ通常の Enter 処理
        return self._on_enter(event)

    def _on_tab(self, event):
        """Tab キー処理: タブ文字の代わりにスペース4つを挿入する。"""
        self.editor.insert(tk.INSERT, "    ")
        return "break"  # デフォルトのフォーカス移動をキャンセル

    def _on_backspace(self, event):
        """
        Backspace キー処理: カーソル直前がスペース4つなら一括削除する。
        通常の1文字削除は Tkinter のデフォルト動作に任せる。
        """
        cursor    = self.editor.index(tk.INSERT)
        line, col = map(int, cursor.split("."))
        if col >= 4:
            before = self.editor.get(f"{line}.{col-4}", f"{line}.{col}")
            if before == "    ":
                self.editor.delete(f"{line}.{col-4}", f"{line}.{col}")
                return "break"
        # 4スペースでなければデフォルトの Backspace 動作に任せる

    def _auto_close(self, open_c, close_c):
        """
        括弧・引用符の自動補完。
        入力した文字に対応する閉じ括弧を自動挿入し、カーソルを中に移動する。
        引用符の場合、次の文字が同じ引用符なら閉じ括弧をスキップする（二重挿入防止）。
        """
        if open_c == close_c:
            # 引用符の場合: 次の文字が同じなら閉じ括弧をスキップ
            cursor    = self.editor.index(tk.INSERT)
            next_char = self.editor.get(cursor, f"{cursor}+1c")
            if next_char == open_c:
                self.editor.mark_set(tk.INSERT, f"{cursor}+1c")
                return "break"
        # 開き + 閉じ括弧を挿入してカーソルを中央に移動
        self.editor.insert(tk.INSERT, open_c + close_c)
        cursor = self.editor.index(tk.INSERT)
        self.editor.mark_set(tk.INSERT, f"{cursor}-{len(close_c)}c")
        return "break"


    # ==========================================================
    # キーボードショートカットの登録
    # ==========================================================

    def _bind_shortcuts(self):
        """アプリ全体のキーボードショートカットをまとめて登録する。"""
        self.root.bind("<Control-n>",     lambda e: self.new_file())
        self.root.bind("<Control-o>",     lambda e: self.open_file())
        self.root.bind("<Control-s>",     lambda e: self.save_file())
        self.root.bind("<Control-S>",     lambda e: self.save_as_file())   # Shift+S
        self.root.bind("<Control-q>",     lambda e: self.quit_app())
        self.root.bind("<Control-z>",     lambda e: self.undo())
        self.root.bind("<Control-y>",     lambda e: self.redo())
        self.root.bind("<Control-f>",     lambda e: self.open_search())
        self.root.bind("<Control-h>",     lambda e: self.open_replace())
        self.root.bind("<Control-slash>", lambda e: self.toggle_comment())
        self.root.bind("<Control-i>",     lambda e: self.auto_indent())
        self.root.bind("<Control-equal>", lambda e: self.change_font_size(1))
        self.root.bind("<Control-minus>", lambda e: self.change_font_size(-1))
        self.root.bind("<F5>",            lambda e: self.run_code())
        self.root.bind("<F6>",            lambda e: self.stop_code())
        self.root.bind("<F7>",            lambda e: self.clear_output())


    # ==========================================================
    # ファイル操作
    # ==========================================================

    def new_file(self):
        """新規ファイルを作成する。未保存の変更がある場合は確認ダイアログを表示する。"""
        if self.is_modified:
            if not messagebox.askyesno("確認", "変更を破棄して新規作成しますか？"):
                return
        self.editor.delete("1.0", tk.END)
        self.current_file = None
        self.is_modified  = False
        self.root.title("JS Editor - Untitled")
        self._set_status_msg("新規ファイルを作成しました")

    def open_file(self):
        """ファイル選択ダイアログを開き、選択したファイルをエディタに読み込む。"""
        path = filedialog.askopenfilename(
            filetypes=[("JavaScript", "*.js *.mjs *.cjs"),
                       ("すべてのファイル", "*.*")]
        )
        if not path:
            return  # キャンセルされた場合は何もしない
        with open(path, "r", encoding="utf-8") as f:
            content = f.read()
        self.editor.delete("1.0", tk.END)
        self.editor.insert("1.0", content)
        self.current_file = path
        self.is_modified  = False
        self.root.title(f"JS Editor - {os.path.basename(path)}")
        # 読み込み後すぐにハイライトを適用
        self._highlight_syntax()
        self._update_line_numbers()
        self._set_status_msg(f"ファイルを開きました: {path}")

    def save_file(self):
        """現在のファイルに上書き保存する。未保存の場合は名前を付けて保存に移行する。"""
        if not self.current_file:
            self.save_as_file()
            return
        self._write_file(self.current_file)

    def save_as_file(self):
        """名前を付けて保存ダイアログを開き、指定したパスに保存する。"""
        path = filedialog.asksaveasfilename(
            defaultextension=".js",
            filetypes=[("JavaScript", "*.js *.mjs *.cjs"),
                       ("すべてのファイル", "*.*")]
        )
        if not path:
            return  # キャンセルされた場合は何もしない
        self._write_file(path)
        self.current_file = path
        self.root.title(f"JS Editor - {os.path.basename(path)}")

    def _write_file(self, path):
        """指定パスにエディタの内容を UTF-8 で書き込む共通処理。"""
        content = self.editor.get("1.0", tk.END)
        with open(path, "w", encoding="utf-8") as f:
            f.write(content)
        self.is_modified = False
        self._set_status_msg(f"保存しました: {path}")

    def quit_app(self):
        """アプリを終了する。実行中プロセスを停止し、未保存の変更を確認する。"""
        self.stop_code()  # 実行中の Node.js プロセスを先に止める
        if self.is_modified:
            if not messagebox.askyesno("確認", "変更を破棄して終了しますか？"):
                return
        self.root.quit()


    # ==========================================================
    # 編集機能
    # ==========================================================

    def undo(self):
        """元に戻す（Tkinter 組み込みの Undo 機能を使用）。"""
        try:
            self.editor.edit_undo()
        except tk.TclError:
            pass  # これ以上戻れない場合は無視

    def redo(self):
        """やり直し（Tkinter 組み込みの Redo 機能を使用）。"""
        try:
            self.editor.edit_redo()
        except tk.TclError:
            pass  # これ以上進めない場合は無視

    def toggle_comment(self):
        """
        選択行（または現在行）をコメントアウト / コメント解除する。
        すべての行が // で始まっていれば解除、そうでなければコメントアウトする。
        """
        try:
            # 選択範囲がある場合はその範囲を対象にする
            start = self.editor.index("sel.first linestart")
            end   = self.editor.index("sel.last lineend")
        except tk.TclError:
            # 選択範囲がない場合はカーソル行のみ対象
            line  = self.editor.index(tk.INSERT).split(".")[0]
            start = f"{line}.0"
            end   = f"{line}.end"

        lines = self.editor.get(start, end).split("\n")
        # 空行を除いた全行が // で始まっているかチェック
        all_commented = all(
            l.lstrip().startswith("//") for l in lines if l.strip()
        )

        new_lines = []
        for line in lines:
            if all_commented:
                # コメント解除: 行頭の // と直後のスペースを除去
                new_lines.append(re.sub(r"^(\s*)//\s?", r"\1", line))
            else:
                # コメントアウト: インデントの後に // を挿入
                new_lines.append(re.sub(r"^(\s*)", r"\1// ", line))

        self.editor.delete(start, end)
        self.editor.insert(start, "\n".join(new_lines))

    def auto_indent(self):
        """
        コード全体のインデントを簡易整形する。
        { [ ( でインデントを増やし、} ] ) で減らす。
        ※ 文字列・コメント内の括弧は考慮しない簡易実装。
        """
        code   = self.editor.get("1.0", tk.END)
        lines  = code.split("\n")
        result = []
        depth  = 0          # 現在のインデント深度
        indent = "    "     # 1段あたりのインデント（スペース4つ）

        for line in lines:
            stripped = line.strip()
            if not stripped:
                result.append("")  # 空行はそのまま
                continue

            # 閉じ括弧で始まる行はインデントを先に減らす
            if stripped.startswith(("}", ")", "]")):
                depth = max(0, depth - 1)

            result.append(indent * depth + stripped)

            # 開き括弧の数 - 閉じ括弧の数 だけ次の行のインデントを変える
            opens  = (stripped.count("{") + stripped.count("(")
                      + stripped.count("["))
            closes = (stripped.count("}") + stripped.count(")")
                      + stripped.count("]"))
            depth  = max(0, depth + opens - closes)

        self.editor.delete("1.0", tk.END)
        self.editor.insert("1.0", "\n".join(result))
        self._highlight_syntax()
        self._set_status_msg("インデントを整形しました")


    # ==========================================================
    # 検索・置換
    # ==========================================================

    def open_search(self):
        """検索ダイアログを開く。"""
        SearchDialog(self.root, self.editor, replace=False)

    def open_replace(self):
        """検索・置換ダイアログを開く。"""
        SearchDialog(self.root, self.editor, replace=True)


    # ==========================================================
    # フォントサイズ変更
    # ==========================================================

    def change_font_size(self, delta):
        """
        エディタと行番号のフォントサイズを変更する。
        delta が正なら拡大、負なら縮小。8〜32pt の範囲に制限する。
        """
        try:
            f    = font.Font(font=self.editor["font"])
            size = max(8, min(32, f.actual()["size"] + delta))
            nf   = (f.actual()["family"], size)
            self.editor.config(font=nf)
            self.line_numbers.config(font=nf)
        except Exception:
            pass


    # ==========================================================
    # ステータスバー更新
    # ==========================================================

    def _update_status(self):
        """カーソル位置（行・列）をステータスバーに表示する。"""
        cursor    = self.editor.index(tk.INSERT)
        line, col = cursor.split(".")
        self.status_right.config(text=f"行: {line}  列: {int(col)+1}")

    def _set_status_msg(self, msg):
        """
        ステータスバーにメッセージを表示する。
        3秒後に自動的に「準備完了」に戻る。
        """
        self.status_msg.config(text=msg)
        self.root.after(3000, lambda: self.status_msg.config(text="準備完了"))

    def _mark_modified(self):
        """
        未保存の変更があることをタイトルバーに「● 」プレフィックスで示す。
        すでにマーク済みの場合は何もしない。
        """
        if not self.is_modified:
            self.is_modified = True
            title = self.root.title()
            if not title.startswith("● "):
                self.root.title("● " + title)


    # ==========================================================
    # 実行シミュレータ（Node.js 連携）
    # ==========================================================

    def run_code(self):
        """
        エディタのコードを Node.js で実行する。
        コードを一時ファイルに書き出し、別スレッドで node コマンドを起動する。
        実行中は UI をブロックしない。
        """
        # すでに実行中のプロセスがあれば先に停止する
        if self._run_process and self._run_process.poll() is None:
            self.stop_code()

        code = self.editor.get("1.0", tk.END)
        if not code.strip():
            self._append_output("⚠ コードが空です。\n", "warning")
            return

        # 前回のエラーハイライトをクリア
        self.editor.tag_remove("error_line", "1.0", tk.END)
        self.clear_output()

        # Node.js がインストールされているか確認
        if not self._check_node():
            return

        # コードを一時ファイルに書き出す（実行後に自動削除）
        try:
            tmp = tempfile.NamedTemporaryFile(
                suffix=".js", delete=False,
                mode="w", encoding="utf-8"
            )
            tmp.write(code)
            tmp.flush()
            tmp.close()
            self._tmp_file = tmp.name
        except Exception as e:
            self._append_output(f"❌ 一時ファイル作成エラー: {e}\n", "stderr")
            return

        self._append_output("▶ 実行開始\n", "info")
        self._set_run_status("実行中", "#a6e3a1")

        # 別スレッドで実行（UI をブロックしない）
        thread = threading.Thread(
            target=self._execute, args=(tmp.name,), daemon=True
        )
        thread.start()

    def _check_node(self):
        """
        Node.js がインストールされているか確認する。
        バージョンを出力パネルに表示し、未インストールの場合はエラーを表示する。
        """
        try:
            result = subprocess.run(
                ["node", "--version"],
                capture_output=True, text=True, timeout=5
            )
            ver = result.stdout.strip()
            self._append_output(f"ℹ Node.js {ver}\n", "timestamp")
            return True
        except FileNotFoundError:
            self._append_output(
                "❌ Node.js が見つかりません。\n"
                "   sudo apt install nodejs -y  でインストールしてください。\n",
                "stderr"
            )
            self._set_run_status("エラー", "#f38ba8")
            return False
        except Exception as e:
            self._append_output(f"❌ Node.js 確認エラー: {e}\n", "stderr")
            return False

    def _execute(self, filepath):
        """
        Node.js でファイルを実行する（別スレッドで動作）。
        stdout / stderr を別スレッドで並行して読み取り、
        UI スレッドに after() 経由で安全に渡す。
        """
        try:
            # Node.js プロセスを起動
            self._run_process = subprocess.Popen(
                ["node", filepath],
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
                stdin=subprocess.PIPE,
                text=True,
                bufsize=1,  # 行バッファリング（リアルタイム出力のため）
            )

            def read_stdout():
                """stdout を1行ずつ読み取り出力パネルに表示する。"""
                for line in self._run_process.stdout:
                    # UI 更新は必ずメインスレッドで行う
                    self.root.after(0, self._append_output, line, "stdout")
                self._run_process.stdout.close()

            def read_stderr():
                """stderr を1行ずつ読み取り出力パネルに赤字で表示する。"""
                for line in self._run_process.stderr:
                    self.root.after(0, self._append_output, line, "stderr")
                    # エラー行番号を解析してエディタをハイライト
                    self.root.after(0, self._highlight_error_line, line)
                self._run_process.stderr.close()

            # stdout と stderr を並行して読み取るスレッドを起動
            t1 = threading.Thread(target=read_stdout, daemon=True)
            t2 = threading.Thread(target=read_stderr, daemon=True)
            t1.start()
            t2.start()
            t1.join()
            t2.join()

            # プロセス終了を待って終了コードを取得
            returncode = self._run_process.wait()

            if returncode == 0:
                self.root.after(
                    0, self._append_output,
                    "\n✅ 正常終了 (exit code 0)\n", "success"
                )
                self.root.after(0, self._set_run_status, "完了", "#a6e3a1")
            else:
                self.root.after(
                    0, self._append_output,
                    f"\n❌ 異常終了 (exit code {returncode})\n", "stderr"
                )
                self.root.after(0, self._set_run_status, "エラー", "#f38ba8")

        except Exception as e:
            self.root.after(
                0, self._append_output, f"❌ 実行エラー: {e}\n", "stderr"
            )
            self.root.after(0, self._set_run_status, "エラー", "#f38ba8")
        finally:
            # 実行後は一時ファイルを必ず削除する
            try:
                os.unlink(filepath)
            except Exception:
                pass
            self._run_process = None

    def _highlight_error_line(self, stderr_line):
        """
        Node.js のエラー出力から行番号を抽出してエディタの該当行をハイライトする。
        Node.js のエラー形式例: "/tmp/xxx.js:5:10"  → 5行目
        """
        # "ファイル名:行番号" または "ファイル名:行番号:列番号" の形式を検索
        match = re.search(r":(\d+)(?::\d+)?(?:\)|$)", stderr_line)
        if match:
            line_no = match.group(1)
            try:
                self.editor.tag_add(
                    "error_line",
                    f"{line_no}.0",
                    f"{line_no}.end+1c"
                )
                # エラー行が見えるようにスクロール
                self.editor.see(f"{line_no}.0")
            except Exception:
                pass

    def stop_code(self):
        """
        実行中の Node.js プロセスを強制終了する。
        プロセスが存在しない場合はステータスを待機中に戻すだけ。
        """
        if self._run_process and self._run_process.poll() is None:
            self._run_process.terminate()
            self._append_output("\n⏹ 実行を停止しました。\n", "warning")
            self._set_run_status("停止", "#f9e2af")
        else:
            self._set_run_status("待機中", self.theme["line_fg"])

    def clear_output(self):
        """出力パネルの内容をすべてクリアしてステータスを待機中に戻す。"""
        self.output.config(state=tk.NORMAL)
        self.output.delete("1.0", tk.END)
        self.output.config(state=tk.DISABLED)
        self._set_run_status("待機中", self.theme["line_fg"])

    def _append_output(self, text, tag="stdout"):
        """
        出力パネルにテキストを追記する。
        state=DISABLED のウィジェットに書き込むため、一時的に NORMAL にする。
        tag で文字色を切り替える（stdout / stderr / info / success / warning）。
        """
        self.output.config(state=tk.NORMAL)
        self.output.insert(tk.END, text, tag)
        self.output.see(tk.END)  # 常に最新行が見えるようにスクロール
        self.output.config(state=tk.DISABLED)

    def _set_run_status(self, text, color):
        """実行ステータスラベルのテキストと色を更新する。"""
        self.run_status.config(text=f"●  {text}", fg=color)

    def _send_stdin(self, event=None):
        """
        stdin 入力欄のテキストを実行中プロセスの標準入力に送信する。
        readline() を使うスクリプト（例: prompt() の代替）に対応している。
        """
        text = self.stdin_var.get()
        if not text:
            return
        if self._run_process and self._run_process.poll() is None:
            try:
                self._run_process.stdin.write(text + "\n")
                self._run_process.stdin.flush()
                # 送信内容を出力パネルにエコー表示
                self._append_output(f"> {text}\n", "info")
            except Exception as e:
                self._append_output(f"❌ stdin 送信エラー: {e}\n", "stderr")
        else:
            self._append_output("⚠ 実行中のプロセスがありません。\n", "warning")
        self.stdin_var.set("")  # 入力欄をクリア


# ============================================================
# 検索・置換ダイアログクラス
#   モーダルダイアログとして表示し、エディタ内のテキストを検索・置換する。
#   replace=False で検索のみ、replace=True で置換機能も表示する。
# ============================================================
class SearchDialog:

    def __init__(self, parent, editor, replace=False):
        """
        検索・置換ダイアログを初期化して表示する。

        Args:
            parent  : 親ウィンドウ
            editor  : 対象の tk.Text ウィジェット
            replace : True なら置換欄も表示する
        """
        self.editor  = editor
        self.results = []   # 検索結果の位置リスト [(start, end), ...]
        self.current = -1   # 現在フォーカスしている検索結果のインデックス

        self.win = tk.Toplevel(parent)
        self.win.title("置換" if replace else "検索")
        self.win.geometry("420x160" if replace else "420x110")
        self.win.configure(bg="#1e1e2e")
        self.win.resizable(False, False)
        self.win.transient(parent)  # 親ウィンドウに追従する
        self.win.grab_set()         # このダイアログが閉じるまで親を操作不可にする

        # ウィジェット共通スタイル
        lbl_style = {"bg": "#1e1e2e", "fg": "#cdd6f4", "font": ("Sans", 10)}
        ent_style = {
            "bg": "#313244", "fg": "#cdd6f4",
            "insertbackground": "#f5c2e7",
            "relief": "flat", "font": ("Monospace", 11), "width": 28,
        }
        btn_style = {
            "bg": "#45475a", "fg": "#cdd6f4",
            "relief": "flat", "padx": 8, "pady": 3,
            "cursor": "hand2", "font": ("Sans", 9),
        }

        # 検索欄
        tk.Label(self.win, text="検索:", **lbl_style).grid(
            row=0, column=0, padx=10, pady=10, sticky="e"
        )
        self.search_var = tk.StringVar()
        tk.Entry(self.win, textvariable=self.search_var, **ent_style).grid(
            row=0, column=1, padx=5
        )

        # 置換欄（replace=True のときのみ表示）
        if replace:
            tk.Label(self.win, text="置換:", **lbl_style).grid(
                row=1, column=0, padx=10, pady=5, sticky="e"
            )
            self.replace_var = tk.StringVar()
            tk.Entry(self.win, textvariable=self.replace_var, **ent_style).grid(
                row=1, column=1, padx=5
            )

        # ボタン行
        btn_row   = 2 if replace else 1
        btn_frame = tk.Frame(self.win, bg="#1e1e2e")
        btn_frame.grid(row=btn_row, column=0, columnspan=2, pady=10)

        tk.Button(btn_frame, text="次を検索",
                  command=self.find_next, **btn_style).pack(side=tk.LEFT, padx=4)
        tk.Button(btn_frame, text="前を検索",
                  command=self.find_prev, **btn_style).pack(side=tk.LEFT, padx=4)
        if replace:
            tk.Button(btn_frame, text="置換",
                      command=self.replace_one, **btn_style).pack(side=tk.LEFT, padx=4)
            tk.Button(btn_frame, text="全て置換",
                      command=self.replace_all, **btn_style).pack(side=tk.LEFT, padx=4)
        tk.Button(btn_frame, text="閉じる",
                  command=self.win.destroy, **btn_style).pack(side=tk.LEFT, padx=4)

        # キーボードショートカット
        self.win.bind("<Return>", lambda e: self.find_next())
        self.win.bind("<Escape>", lambda e: self.win.destroy())

    def _do_search(self):
        """
        検索欄の文字列でエディタ全体を検索し、
        すべての一致箇所をハイライトして self.results に格納する。
        """
        # 前回の検索ハイライトをクリア
        self.editor.tag_remove("search_highlight", "1.0", tk.END)
        query = self.search_var.get()
        if not query:
            return

        self.results = []
        start = "1.0"
        while True:
            pos = self.editor.search(query, start, tk.END)
            if not pos:
                break  # 見つからなければ終了
            end = f"{pos}+{len(query)}c"
            self.editor.tag_add("search_highlight", pos, end)
            self.results.append((pos, end))
            start = end  # 次の検索は現在の終端から開始

    def find_next(self):
        """次の検索結果にジャンプする。末尾に達したら先頭に戻る（ループ検索）。"""
        self._do_search()
        if not self.results:
            return
        self.current = (self.current + 1) % len(self.results)
        pos, _ = self.results[self.current]
        self.editor.see(pos)
        self.editor.mark_set(tk.INSERT, pos)

    def find_prev(self):
        """前の検索結果にジャンプする。先頭に達したら末尾に戻る（ループ検索）。"""
        self._do_search()
        if not self.results:
            return
        self.current = (self.current - 1) % len(self.results)
        pos, _ = self.results[self.current]
        self.editor.see(pos)
        self.editor.mark_set(tk.INSERT, pos)

    def replace_one(self):
        """現在フォーカスしている検索結果を置換文字列で1件置換する。"""
        self._do_search()
        if not self.results:
            return
        if self.current < 0:
            self.find_next()  # まだ検索していなければ最初の結果に移動
            return
        pos, end = self.results[self.current]
        self.editor.delete(pos, end)
        self.editor.insert(pos, self.replace_var.get())
        self.find_next()  # 置換後は次の結果に移動

    def replace_all(self):
        """
        すべての検索結果を置換文字列で一括置換する。
        後ろから置換することでインデックスのずれを防ぐ。
        """
        self._do_search()
        # reversed() で後ろから置換してインデックスのずれを防ぐ
        for pos, end in reversed(self.results):
            self.editor.delete(pos, end)
            self.editor.insert(pos, self.replace_var.get())
        self.results = []
        self.current = -1


# ============================================================
# エントリーポイント
# ============================================================
if __name__ == "__main__":
    root = tk.Tk()
    app  = JSEditor(root)
    root.mainloop()
