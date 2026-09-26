# shiwake-mcp

A dependency-free MCP server for journal entry testing (JET).

It takes journal entries from a general ledger, applies 11 screening rules, and returns them ordered by the sequence a human should review them in. *Shiwake* (仕訳) is the Japanese word for a journal entry.

[日本語](README.md)

## Why zero dependencies

`dependencies` in `package.json` is empty. Nothing is installed.

Adding third-party packages to a tool that handles accounting data means explaining, at every deployment, what each package does. Inside an audit firm's network that explanation costs more than the implementation. With no dependencies, the only code to review is in this repository.

The MCP stdio transport is newline-delimited JSON-RPC 2.0. It takes about 200 lines to implement without an SDK.

## Running it

Requires Node.js 20 or later.

```bash
git clone https://github.com/USHIKUNDESUYO/shiwake-mcp.git
cd shiwake-mcp
npm test
```

No `npm install` step.

### Try it locally first

The repository ships 383 synthetic entries with known anomalies planted in them.

```bash
npm run demo
```

383 entries narrow down to 25. The score is the sum of each rule's severity weight, so entries hit by several rules at once rise to the top.

### Connecting it as an MCP server

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

`npx` downloads this one package and nothing else, because there are no dependencies.

To run a clone of this repository instead, set `command` to `node` and `args` to `["/path/to/shiwake-mcp/src/server.js"]`.

## Tools

| Tool | Returns |
|---|---|
| `screen_journals` | All rules applied, ranked by risk score |
| `check_balance` | Entries where debits and credits disagree, with the difference |
| `benford_analysis` | First-digit distribution, MAD, chi-square |
| `detect_duplicates` | Groups of identical entries |
| `list_rules` | The implemented rules and what each one indicates |

Entries accept either a simple form (`debit_account` / `credit_account` / `amount`) or a line form (`lines: [{ account, debit, credit }]`) for compound entries and consumption tax.

If a single entry cannot be read, the whole call stops by default and reports which entry failed and why. Pass `skipInvalid: true` to exclude unreadable entries and carry on; they come back in `invalidRows` with their position, ID and reason.

## Rules

| ID | Severity | What it indicates |
|---|---|---|
| `unbalanced` | high | Manual entry, import failure, or alteration |
| `self_approval` | high | Segregation of duties is not operating |
| `threshold_avoidance` | high | Splitting entries to stay under an approval limit |
| `duplicate` | medium | Double posting, or a legitimate recurring entry |
| `backdated` | medium | Cut-off error or retrospective posting |
| `period_end_large` | medium | Where earnings management would appear first |
| `rare_account_pair` | medium | Processing outside the normal transaction flow |
| `weekend_or_holiday` | low | Posted outside the business cycle |
| `after_hours` | low | Weak alone, meaningful in combination |
| `round_amount` | low | Estimates, approximations, reclassifications |
| `missing_description` | low | Audit trail quality |

`threshold_avoidance` and `period_end_large` stay dormant unless `approvalThresholds` and `fiscalYearEnd` are supplied. A rule firing blindly produces false positives, so it stops explicitly instead.

`weekend_or_holiday` skips entries dated on the last day of a month by default. Month-end and period-end adjustments usually carry the month-end date even when it falls on a weekend; in a year when March 31 is a Sunday, every year-end adjustment would otherwise be flagged. Pass `exemptMonthEnd: false` to include them.

`weekend_or_holiday` also recognises Japanese national holidays, including substitute holidays and the in-between citizens' holiday, for 2000–2099. They are computed from the Public Holiday Act rather than a downloaded list, and the computation matches the Cabinet Office list for every day from 2000 to 2027. Company-specific holidays such as the New Year break go in `holidays`. For ledgers outside Japan, pass `japaneseHolidays: false`.

`duplicate` and `rare_account_pair` sort the accounts on each side before comparing, so the order of lines within an entry does not change the result.

## On Benford analysis

MAD thresholds follow Nigrini, M. J. *Benford's Law* (Wiley, 2012), Table 5.1. These are widely used in practice but are not set by any law or auditing standard.

Results below 300 entries carry a note, since the thresholds assume a large sample.

Benford describes a population, not an individual entry. A distorted distribution is often explained by the nature of the business: fixed unit prices, regulated pricing, or a high volume of small transactions.

## Limitations

**A finding is not evidence of fraud.** Every rule picks up legitimate processing in volume. Most duplicates are recurring monthly entries; large period-end amounts are ordinary if revenue lands at period end.

This tool decides **where to start looking**. Evaluating what it surfaces remains human work.

It cannot:

- substitute for audit procedures (it does not yield sufficient appropriate audit evidence)
- conclude on the presence or absence of fraud
- judge whether an account classification is substantively correct
- determine tax treatment

It is not a basis for forming an audit opinion or supporting a tax filing.

## Handling real data

Everything in `examples/` is synthetic, generated from a fixed seed. `.gitignore` excludes `*.csv`, `*.xlsx`, `journals.json` and `/data/` as a guard against committing real ledger data.

The server makes no network calls. It reads stdin and writes stdout.

## Tests

```bash
npm test
```

67 tests. The MCP server tests spawn the server as a child process and exchange real JSON-RPC messages over stdio.

## License

MIT

## Author

Ushio Hoshino, CPA (Japan)
