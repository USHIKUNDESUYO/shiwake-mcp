# shiwake-mcp

仕訳データの一次スクリーニングを行う MCP サーバー。依存ライブラリはゼロ。

総勘定元帳から仕訳を受け取り、11個のルールを当てて、先に人間が目を通すべき順番に並べ替えて返します。監査の現場でいう仕訳テスト（Journal Entry Testing）を、AIエージェントから呼べる形にしたものです。

[English](README.en.md)

## 依存ライブラリを持たない理由

`npm install` で入るものが1つもありません。`package.json` の `dependencies` は空です。

会計データを扱う道具に外部依存を足すと、導入のたびに「このパッケージは何をしているのか」を説明する必要が出ます。監査法人や会計事務所のネットワークで動かすとき、その説明コストは実装の手間より高くつきます。依存がゼロなら、読むべきコードはこのリポジトリの中だけで閉じます。

MCP の stdio トランスポートは、行区切りの JSON-RPC 2.0 です。SDK を使わなくても 200 行ほどで書けます。

## 動かす

Node.js 20 以上が必要です。

### MCP サーバーとして繋ぐ

npm に公開しているので、`npx` で起動できます。事前のインストールは要りません。ダウンロードされるのはこのパッケージ1つだけです。依存がないので、ほかには何も入りません。

Claude Code なら1行です。

```bash
claude mcp add shiwake -- npx -y shiwake-mcp
```

名前の前に `--scope project` を付けると、プロジェクト直下の `.mcp.json` に書き込まれ、チームで共有できます。

Claude Desktop は設定ファイル（`claude_desktop_config.json`）に追記します。

```json
{
  "mcpServers": {
    "shiwake": {
      "command": "npx",
      "args": ["-y", "shiwake-mcp"]
    }
  }
}
```

バージョンを固定したい場合は `shiwake-mcp@0.1.0` のように指定します。コードを読んでから動かしたい場合は、リポジトリを clone して `"command": "node"`、`"args": ["/path/to/shiwake-mcp/src/server.js"]` と直接指定してください。

### まず手元で試す

リポジトリを clone すると、同梱のサンプルデータ（合成データ383件、既知の異常を混ぜてあります）で挙動を確かめられます。`npm install` は要りません。

```bash
git clone https://github.com/USHIKUNDESUYO/shiwake-mcp.git
cd shiwake-mcp
npm run demo
```

```
検査対象   383 件
検出       53 件 / 対象仕訳 25 件
重要度     high 13 / medium 15 / low 25
ベンフォード  MAD 0.012241 → 許容の限界（n=383）

ルール別:
     営業時間外の入力                11 件
     キリのよい金額                   9 件
  !! 承認限度額の直下                 7 件
  !  重複仕訳                         5 件
  !! 起票者と承認者が同一             4 件
  !  期末直前の大口計上               4 件
  !  計上日と入力日の乖離             3 件
  !  稀な勘定科目の組み合わせ         3 件
     休日の計上                       3 件
  !! 貸借不一致                       2 件
     摘要が空                         2 件

確認の優先順位（上位 20 件）:
  [ 23] JV-0382    2025-09-06       3000000  self_approval, rare_account_pair, weekend_or_holiday, after_hours, round_amount, missing_description
  [ 19] JV-0365    2026-03-30       8900000  self_approval, period_end_large, after_hours, round_amount
        開発委託費
  [ 17] JV-0362    2026-01-22       1200000  unbalanced, rare_account_pair, round_amount
        業務委託費計上
  （以下省略）
```

383件が25件に絞られます。スコアは各ルールの重要度の合計で、複数のルールに同時に当たった仕訳ほど上に来ます。

## ツール

| ツール | 何を返すか |
|---|---|
| `screen_journals` | 全ルールを当て、リスクスコア順に並べ替えた一覧 |
| `check_balance` | 貸借が一致しない仕訳と、その差額 |
| `benford_analysis` | 金額の先頭桁の分布、MAD、χ² |
| `detect_duplicates` | 完全に一致する仕訳のグループ |
| `list_rules` | 実装されているルールの一覧と趣旨 |

入力の仕訳は、簡易形と明細形のどちらでも受けます。

```json
{
  "id": "JV-0001",
  "date": "2026-03-31",
  "entered_at": "2026-04-02T23:41:00+09:00",
  "debit_account": "売掛金",
  "credit_account": "売上高",
  "amount": 12000000,
  "description": "3月度売上計上",
  "created_by": "acc01",
  "approved_by": "mgr01"
}
```

消費税や複合仕訳のように行数が増えるものは、明細形で渡します。

```json
{
  "id": "JV-0002",
  "date": "2026-03-31",
  "lines": [
    { "account": "外注費", "debit": 1000000 },
    { "account": "仮払消費税", "debit": 100000 },
    { "account": "買掛金", "credit": 1100000 }
  ]
}
```

## ルール

| ID | 内容 | 重要度 | 何を示すか |
|---|---|---|---|
| `unbalanced` | 貸借不一致 | high | 手入力、取込不良、改変のいずれか |
| `self_approval` | 起票者と承認者が同一 | high | 職務分掌が効いていない |
| `threshold_avoidance` | 承認限度額の直下 | high | 分割計上による承認回避 |
| `duplicate` | 重複仕訳 | medium | 二重計上、または正当な定期計上 |
| `backdated` | 計上日と入力日の乖離 | medium | 期間帰属の誤り、遡及計上 |
| `period_end_large` | 期末直前の大口計上 | medium | 利益調整が現れるならこの窓 |
| `rare_account_pair` | 稀な勘定科目の組み合わせ | medium | 通常の取引フローから外れた処理 |
| `weekend_or_holiday` | 休日の計上 | low | 業務サイクルの外での処理 |
| `after_hours` | 営業時間外の入力 | low | 単独では弱いが、重なると効く |
| `round_amount` | キリのよい金額 | low | 見積、概算、付け替え |
| `missing_description` | 摘要が空 | low | 監査証跡としての品質 |

前提条件はオプションで渡します。

```json
{
  "fiscalYearEnd": "03-31",
  "businessHours": [9, 18],
  "holidays": ["2026-01-01", "2026-01-12"],
  "approvalThresholds": [1000000, 5000000],
  "backdatedDaysThreshold": 30
}
```

`approvalThresholds` と `fiscalYearEnd` を渡さなければ、対応するルールは動きません。関係のないルールが空振りして偽陽性を増やすより、明示的に止まるほうがよいという判断です。

## ベンフォード分析について

MAD の判定境界は Nigrini, M. J. *Benford's Law* (Wiley, 2012) Table 5.1 の値を使っています。実務で広く引かれている値ですが、法令や監査基準が定めたものではありません。

サンプルが300件を下回る場合、結果に注記が付きます。この判定境界は大標本を前提にしているためです。

そして、ベンフォードは母集団の性質を見る道具であって、個別の仕訳を判定するものではありません。分布が崩れていても、事業の性質（単価が固定の商売、規制価格、少額取引の多い業態）で説明がつくことが普通にあります。

## この道具の限界

**検出は不正の証拠ではありません。** どのルールも、正当な処理を大量に拾います。重複仕訳の多くは毎月同額の定期計上ですし、期末の大口は期末に売上が立つ商売なら当たり前に出ます。

この道具がやるのは、**母集団のどこから見るかを決めること**だけです。検出された仕訳をどう評価するかは、依然として人の仕事として残ります。

以下は、この道具では**できません**。

- 監査手続そのものの代替（十分かつ適切な監査証拠は、これでは得られません）
- 不正の有無の結論づけ
- 勘定科目の内容的な妥当性の判断
- 税務上の取扱いの判定

監査意見の形成や、税務申告の根拠として使えるものではありません。

## 実データの取り扱い

`examples/` に入っているのは合成データです。固定シードで生成しているので、`node examples/generate.js` を何度実行しても同じファイルになります。

`.gitignore` で `*.csv` `*.xlsx` `journals.json` `/data/` を除外しています。実際の仕訳データをコミットしないための保険です。

サーバー自体はネットワークに出ません。読むのは stdin だけ、書くのは stdout だけです。

## テスト

```bash
npm test
```

48件のテストが走ります。MCP サーバーのテストは、子プロセスとして起こして実際に JSON-RPC を投げる経路で書いています。

CI は Node 20 / 22 / 24 で走ります。テストのほかに、依存が増えていないこと、`package-lock.json` が生まれていないこと、固定シードのサンプルデータが再生成しても一致することを検査しています。依存ゼロはこのリポジトリの前提なので、人の注意ではなく CI で守っています。

## 解説記事

このサーバーを書いた経緯と設計の判断は、記事にしています。

- [会計士がMCPサーバーを書くと、依存ライブラリがゼロになる](https://zenn.dev/ushikundesu/articles/shiwake-mcp-zero-dependency)

## ライセンス

MIT

## 作者

星野宇潮（公認会計士・税理士）
