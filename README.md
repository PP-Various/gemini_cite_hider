# Gemini Cite Hider (Chrome 拡張機能)

Google Gemini（`https://gemini.google.com/*`）、Gemini Notebook（`https://notebook.google.com/*`）および NotebookLM（`https://notebooklm.google.com/*`）の回答画面で、引用バッジへ変換されず生テキストとして露出してしまった `[cite: 1]` や `[cite: 2, 5]` などの内部記法を自動的に非表示にする Manifest V3 拡張機能です。

## 主な機能

- **自動検知・非表示化**: `[cite: 1]`、`[cite: 2, 5]`、`[cite: 3, 4, 6, 7]`、`[cite: 1-3]` などの生引用表記を検知し、直前の不要な半角スペースも含めて自然に非表示化します。
- **コピー＆ペースト対応**: `display: none !important` と `user-select: none !important` を適用した専用 `<span>` でラップするため、回答を選択してコピーしても `[cite: *]` がクリップボードに混入しません。
- **正常バッジの保護**: 正常にレンダリングされた丸い引用チップ（UI バッジ）には影響しません。
- **リアルタイム・ストリーミング対応**: `MutationObserver`（`childList` / `characterData` / Open Shadow DOM）により、回答の生成途中および完了後も遅延なく処理します。
- **誤爆防止**: ユーザー入力欄（`<textarea>`、`<input>`、`contenteditable`、`[role="textbox"]`）やコードブロック（`<pre>`、`<code>`）内のテキストは変更しません。
- **ポップアップ UI**: 拡張機能アイコンから ON / OFF の即時切り替えと、現在のタブで非表示にした件数の確認ができます（`chrome.storage.local` に保存）。

## ファイル構成

- `manifest.json`: Manifest V3 定義ファイル
- `content.js`: DOM 監視・`[cite: *]` 検知および非表示処理
- `styles.css`: 非表示トークン用スタイル
- `background.js`: 拡張機能アイコンバッジ更新用 Service Worker
- `popup.html` / `popup.css` / `popup.js`: ポップアップ UI（ON/OFF トグル・件数カウンター）
- `icons/`: 拡張機能アイコン（16px / 48px / 128px）

## インストール手順（Chrome）

1. Google Chrome で `chrome://extensions/` を開きます。
2. 右上の **「デベロッパー モード」** をオンにします。
3. 左上の **「パッケージ化されていない拡張機能を読み込む」** をクリックします。
4. このプロジェクトのフォルダ（`manifest.json` が含まれるディレクトリ）を選択します。

## 動作確認手順

1. `https://gemini.google.com/`、`https://notebook.google.com/`、または `https://notebooklm.google.com/` を開きます（すでに開いていたタブは一度再読み込みしてください）。
2. `[cite: 2, 5]` のような生テキストが含まれる回答を表示または生成します。
3. 画面上から `[cite: *]` が消え、直前に余分なスペースが残らないこと（例: `学んだ [cite: 2]。` が `学んだ。` になること）を確認します。
4. 回答テキストをドラッグ選択してコピー（`Ctrl+C` / `Cmd+C`）し、メモ帳等に貼り付けて `[cite: *]` が含まれないことを確認します。
5. 入力欄やコードブロック（`` `[cite: 1]` ``）内の文字が消えていないこと、正常な丸い引用バッジが維持されていることを確認します。
6. ツールバーの拡張機能アイコンをクリックし、現在のタブでの非表示件数が表示されること、およびスイッチの OFF / ON で即座に元のテキスト表示と非表示を切り替えられることを確認します。
