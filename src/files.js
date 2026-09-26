/**
 * 手元のファイルから仕訳を読む。
 *
 * MCP サーバーとして動くときは、起動時に許可したフォルダの中だけを読む。
 * AI に別のパスを指定されても、許可の外は開かない。読むだけで、書き込みもネットワークへの送信もしない。
 * コマンドライン版（bin/shiwake.js）は、人が自分で指定したファイルを読むので、この制限をかけない。
 */

import { readFileSync, realpathSync, statSync } from 'node:fs';
import { delimiter, extname, isAbsolute, relative, resolve, sep } from 'node:path';

import { csvToJournals, CsvError } from './csv.js';

const MAX_FILE_BYTES = 256 * 1024 * 1024;

class FileAccessError extends Error {
  constructor(message) {
    super(message);
    this.name = 'FileAccessError';
  }
}

/** 起動引数の --data-dir（何度でも指定できる）と、環境変数 SHIWAKE_DATA_DIR（OS のパス区切りで複数）を集める。 */
function dataDirsFrom(argv = [], env = {}) {
  const dirs = [];
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--data-dir' && argv[i + 1]) dirs.push(argv[(i += 1)]);
  }
  if (env.SHIWAKE_DATA_DIR) dirs.push(...env.SHIWAKE_DATA_DIR.split(delimiter).filter((d) => d.trim() !== ''));
  return dirs;
}

/** target が dir の中（dir 自身は含まない）にあるか。Windows の大文字小文字の違いは path.relative が吸収する。 */
function isInside(dir, target) {
  const rel = relative(dir, target);
  return rel !== '' && rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
}

/** 指定されたパスが、許可したフォルダの中にある実在のファイルなら、その実体のパスを返す。 */
function resolveAllowedFile(file, dataDirs) {
  if (typeof file !== 'string' || file.trim() === '') {
    throw new FileAccessError('file にファイルのパスを指定してください');
  }
  const dirs = dataDirs
    .map((d) => {
      try {
        return realpathSync.native(resolve(d));
      } catch {
        return null;
      }
    })
    .filter(Boolean);
  if (dirs.length === 0) {
    throw new FileAccessError(
      dataDirs.length === 0
        ? 'ファイルを読むには、起動時に --data-dir（または環境変数 SHIWAKE_DATA_DIR）で、読んでよいフォルダを指定してください'
        : `読んでよいフォルダとして指定されたフォルダが見つかりません: ${dataDirs.join(', ')}`
    );
  }

  // 相対パスは、最初に許可したフォルダを起点にする
  const candidate = isAbsolute(file) ? file : resolve(dirs[0], file);
  let real;
  try {
    real = realpathSync.native(candidate);
  } catch {
    throw new FileAccessError(`ファイルが見つかりません: ${file}`);
  }
  // シンボリックリンクをたどった先で判定する。リンクを使って許可の外へ出るのを防ぐため
  if (!dirs.some((d) => isInside(d, real))) {
    throw new FileAccessError(`読んでよいフォルダの外にあるファイルは読みません: ${file}（読めるのは ${dirs.join(', ')} の中だけです）`);
  }
  return real;
}

/** UTF-8 を先に試し、UTF-8 として正しくなければ Shift_JIS として読む。BOM は落とす。 */
function decode(buf) {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(buf);
  } catch {
    try {
      return new TextDecoder('shift_jis').decode(buf);
    } catch {
      throw new FileAccessError('文字コードを UTF-8 でも Shift_JIS でも読めませんでした');
    }
  }
}

/**
 * .json か .csv を読んで、仕訳の配列にする。
 * 戻り値の rowOf は CSV のときだけ入る（i 件目の仕訳が CSV の何行目から始まるか）。
 */
function readJournalFile(path, { columns } = {}) {
  const ext = extname(path).toLowerCase();
  if (ext !== '.json' && ext !== '.csv') throw new FileAccessError(`読めるのは .json と .csv だけです: ${path}`);
  const { size } = statSync(path);
  if (size > MAX_FILE_BYTES) {
    throw new FileAccessError(`ファイルが大きすぎます（${size.toLocaleString()} バイト。上限は ${MAX_FILE_BYTES.toLocaleString()} バイト）`);
  }
  const text = decode(readFileSync(path));

  if (ext === '.json') {
    let raw;
    try {
      raw = JSON.parse(text);
    } catch (err) {
      throw new FileAccessError(`JSON として読めません: ${err.message}`);
    }
    const journals = Array.isArray(raw) ? raw : raw?.journals;
    if (!Array.isArray(journals)) {
      throw new FileAccessError('JSON は仕訳の配列か、{ "journals": [...] } の形にしてください');
    }
    return { format: 'json', journals, rowOf: null, columnsUsed: null, rowCount: journals.length };
  }

  try {
    return { format: 'csv', ...csvToJournals(text, columns) };
  } catch (err) {
    if (err instanceof CsvError) throw new FileAccessError(err.message);
    throw err;
  }
}

export { dataDirsFrom, resolveAllowedFile, readJournalFile, FileAccessError, MAX_FILE_BYTES };
