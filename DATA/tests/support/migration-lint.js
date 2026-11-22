// T-5B-11 (DB5-R14.1, DB5-R14.5, DB5-R14.11; design DC-07, "Compatibility with the Migration_Runner rules", P-29).
// Migration lint helper of the DATA tests. The runner (server/database/migrate.js) checks names, order and checksums
// but does not scan statements (design F4), so the statement rules of DB5-R14 are enforced here, by a test.
//
// The helper only reads: migration text passed in as a string, or the listing and files of a migration directory. It
// writes nothing, opens no database and loads nothing from the application, so it is safe on the real directory.
//
// Rules, each reported as { rule, file, line, ... }:
//   FILE_NAME                    a directory entry whose name is outside ^\d{4}-[a-z0-9-]+\.sql$ (the runner would
//                                silently leave it out), or an entry with a matching name that is not a regular file
//   NOT_CONTIGUOUS               the matching names, sorted as the runner sorts them, do not carry the versions
//                                1, 2, 3, ... in order (a gap, a duplicate, or a first version other than 1)
//   FORBIDDEN_STATEMENT          a statement outside a trigger body that starts with BEGIN, COMMIT (or END, the SQLite
//                                alias of COMMIT), ROLLBACK, VACUUM, ATTACH or PRAGMA (DB5-R14.5)
//   FORBIDDEN_FOREIGN_KEY_ACTION ON DELETE CASCADE, SET NULL or SET DEFAULT, in version 8 and later only (DB5-R14.11)
//   UNTERMINATED_LITERAL         a string literal or quoted identifier that is never closed
//   UNTERMINATED_TRIGGER         a CREATE TRIGGER body without its closing END
// The last two keep the lint closed: text that the lint cannot delimit is reported, never read as harmless.
//
// Method (DC-07):
// 1. Strip. Line comments, block comments, string literals ('...' with ''), and quoted identifiers ("..." with "",
//    `...` with ``, [...]) are replaced by spaces of the same length; line breaks are kept, so offsets and line
//    numbers of the stripped text equal those of the original. A keyword inside them is therefore never seen.
// 2. Tokens. Words are runs of ASCII letters, digits, _ and $, plus non-ASCII characters that are not white space, so
//    begin_at is one word and never the keyword BEGIN. Every other non-space character is a token of its own. A word
//    right after a "." (NEW.end, t.begin) is a qualified name and never counts as a keyword.
// 3. Statements. A statement runs to the next ";". A statement that starts with CREATE [TEMP|TEMPORARY] TRIGGER runs
//    to its first BEGIN; from there its body runs to the END that closes it, where every CASE opens one more level
//    and every END at a deeper level closes one CASE. The body is ignored by the statement rule. A token after that
//    END other than ";" starts the next statement.
// 4. Checks. The statement rule looks at the first token of each statement outside a body. The foreign-key rule looks
//    at every token of the file, because no trigger body can hold a foreign-key clause.
// Known limit: an unquoted column named END or CASE (without a "NEW."-style qualifier) inside a trigger body would
// close the body early; the result is an extra report, never a missed one. Quote such names.
//
// Published exemption. 0001-legacy.sql, the legacy schema adopted unchanged, starts with PRAGMA foreign_keys = ON
// (line 2). DB5-R14.5 forbids PRAGMA outside trigger bodies, and DC-07 requires the lint to accept 0001 to 0007, which
// are immutable (DB5-R14.2). The one statement is therefore listed in PUBLISHED_EXEMPTIONS: in that file only, with
// that exact token text, it is returned in `exempted` instead of `violations`. Any other PRAGMA in 0001, and the same
// PRAGMA in any other file, is a violation. The runner applies migrations inside its open transaction, where SQLite
// treats this PRAGMA as a no-op.
//
// API:
//   lintSql(sql, { file, version })  -> { file, version, strict, violations, exempted, statements }
//       version defaults to the number of a matching file name; without either, the stricter rules of version 8 and
//       later apply. statements: [{ line, endLine, keyword, text, trigger, body: { line, endLine } | null }]
//   lintFileNames(names)             -> { names, violations }    names: the matching names in runner order
//   lintDirectory(directory = MIGRATIONS_DIRECTORY)
//                                    -> { directory, files, violations, exempted }
//       files: [{ name, version, strict, violations, exempted, statements }] for each matching regular file
//   stripSql(sql)                    -> { text, problems }       the stripped text and its UNTERMINATED_LITERAL entries
//   splitStatements(sql)             -> { statements, problems } the statements of step 3 and UNTERMINATED_* entries
//   formatViolation(violation)       -> one readable line, for assertion messages
'use strict';

const fs = require('node:fs');
const path = require('node:path');

const MIGRATIONS_DIRECTORY = path.join(__dirname, '..', '..', 'server', 'database', 'migrations');
const FILE_NAME_PATTERN = /^\d{4}-[a-z0-9-]+\.sql$/;
const STRICT_FROM_VERSION = 8;
const FORBIDDEN_KEYWORDS = Object.freeze(['BEGIN', 'COMMIT', 'ROLLBACK', 'VACUUM', 'ATTACH', 'PRAGMA']);
const KEYWORD_ALIASES = new Map([['END', 'COMMIT']]);
const FORBIDDEN_FOREIGN_KEY_ACTIONS = Object.freeze(['ON DELETE CASCADE', 'SET NULL', 'SET DEFAULT']);
const PUBLISHED_EXEMPTIONS = Object.freeze([
    Object.freeze({ file: '0001-legacy.sql', statement: 'PRAGMA foreign_keys = ON' }),
]);
const RULES = Object.freeze(['FILE_NAME', 'NOT_CONTIGUOUS', 'FORBIDDEN_STATEMENT', 'FORBIDDEN_FOREIGN_KEY_ACTION',
    'UNTERMINATED_LITERAL', 'UNTERMINATED_TRIGGER']);

const CLOSING_QUOTE = new Map([["'", "'"], ['"', '"'], ['`', '`'], ['[', ']']]);
const TOKEN = /(?:[A-Za-z0-9_$]|[^\x00-\x7f\s])+|\S/g;
const STATEMENT_TEXT_LIMIT = 120;

// Line number (from 1) of an offset of `text`.
function lineIndex(text) {
    const starts = [0];
    for (let index = 0; index < text.length; index += 1) if (text.charCodeAt(index) === 10) starts.push(index + 1);
    return offset => {
        let low = 0;
        let high = starts.length - 1;
        while (low < high) {
            const middle = (low + high + 1) >> 1;
            if (starts[middle] <= offset) low = middle;
            else high = middle - 1;
        }
        return low + 1;
    };
}

// End offset (exclusive) of the quoted run that opens at `start`, or -1 when it is never closed. '...', "..." and
// `...` double the quote to escape it; [...] has no escape.
function quoteEnd(sql, start) {
    const close = CLOSING_QUOTE.get(sql[start]);
    for (let index = start + 1; index < sql.length; index += 1) {
        if (sql[index] !== close) continue;
        if (close !== ']' && sql[index + 1] === close) {
            index += 1;
            continue;
        }
        return index + 1;
    }
    return -1;
}

function strip(sql) {
    const out = [];
    const problems = [];
    let index = 0;
    while (index < sql.length) {
        const pair = sql.slice(index, index + 2);
        let end;
        if (pair === '--') {
            end = sql.indexOf('\n', index);
            if (end === -1) end = sql.length;
        } else if (pair === '/*') {
            end = sql.indexOf('*/', index + 2);
            end = end === -1 ? sql.length : end + 2; // SQLite also ends an open block comment at the end of the text
        } else if (CLOSING_QUOTE.has(sql[index])) {
            end = quoteEnd(sql, index);
            if (end === -1) {
                problems.push({ rule: 'UNTERMINATED_LITERAL', offset: index, quote: sql[index] });
                end = sql.length;
            }
        } else {
            out.push(sql[index]);
            index += 1;
            continue;
        }
        for (; index < end; index += 1) out.push(sql.charCodeAt(index) === 10 ? '\n' : ' ');
    }
    return { text: out.join(''), problems };
}

function tokenize(text) {
    const tokens = [];
    for (const match of text.matchAll(TOKEN)) {
        const previous = tokens[tokens.length - 1];
        tokens.push({
            value: match[0],
            upper: match[0].toUpperCase(),
            offset: match.index,
            qualified: previous !== undefined && previous.value === '.',
        });
    }
    return tokens;
}

const isKeyword = (token, word) => token !== undefined && !token.qualified && token.upper === word;

function startsTrigger(tokens, index) {
    if (!isKeyword(tokens[index], 'CREATE')) return false;
    const next = tokens[index + 1];
    const at = isKeyword(next, 'TEMP') || isKeyword(next, 'TEMPORARY') ? index + 2 : index + 1;
    return isKeyword(tokens[at], 'TRIGGER');
}

// Statements as token ranges [first, last]; body is { open, close }, the token indexes of BEGIN and of its END.
function splitTokens(tokens) {
    const statements = [];
    const problems = [];
    let index = 0;
    while (index < tokens.length) {
        if (tokens[index].value === ';') {
            index += 1;
            continue;
        }
        const first = index;
        const trigger = startsTrigger(tokens, index);
        if (trigger) {
            while (index < tokens.length && tokens[index].value !== ';' && !isKeyword(tokens[index], 'BEGIN')) index += 1;
            if (index < tokens.length && tokens[index].value !== ';') {
                const open = index;
                let depth = 0;
                let close = -1;
                for (index = open + 1; index < tokens.length; index += 1) {
                    if (isKeyword(tokens[index], 'CASE')) depth += 1;
                    else if (isKeyword(tokens[index], 'END')) {
                        if (depth === 0) {
                            close = index;
                            break;
                        }
                        depth -= 1;
                    }
                }
                if (close === -1) {
                    problems.push({ rule: 'UNTERMINATED_TRIGGER', offset: tokens[first].offset });
                    close = tokens.length - 1;
                }
                index = close + 1;
                statements.push({ first, last: close, trigger, body: { open, close } });
                continue;
            }
        }
        while (index < tokens.length && tokens[index].value !== ';') index += 1;
        statements.push({ first, last: index - 1, trigger, body: null });
    }
    return { statements, problems };
}

const tokenText = (tokens, first, last) => tokens.slice(first, last + 1).map(token => token.value).join(' ');
const shorten = text => (text.length > STATEMENT_TEXT_LIMIT ? `${text.slice(0, STATEMENT_TEXT_LIMIT - 3)}...` : text);

function analyse(sql) {
    if (typeof sql !== 'string') throw new TypeError('the SQL text must be a string');
    const lineOf = lineIndex(sql);
    const stripped = strip(sql);
    const tokens = tokenize(stripped.text);
    const split = splitTokens(tokens);
    const statements = split.statements.map(({ first, last, trigger, body }) => ({
        line: lineOf(tokens[first].offset),
        endLine: lineOf(tokens[last].offset),
        keyword: tokens[first].upper,
        text: tokenText(tokens, first, last),
        trigger,
        body: body === null ? null : { line: lineOf(tokens[body.open].offset), endLine: lineOf(tokens[body.close].offset) },
    }));
    return { lineOf, stripped, tokens, split, statements };
}

function stripSql(sql) {
    const { lineOf, stripped } = analyse(sql);
    return { text: stripped.text, problems: stripped.problems.map(({ rule, offset, quote }) => ({ rule, line: lineOf(offset), quote })) };
}

function splitStatements(sql) {
    const { lineOf, stripped, split, statements } = analyse(sql);
    const problems = [...stripped.problems, ...split.problems].sort((a, b) => a.offset - b.offset)
        .map(({ rule, offset, quote }) => (quote === undefined ? { rule, line: lineOf(offset) } : { rule, line: lineOf(offset), quote }));
    return { statements, problems };
}

function versionOf(options, file) {
    if (options.version !== undefined && options.version !== null) {
        if (!Number.isSafeInteger(options.version) || options.version < 0) throw new RangeError('version must be an integer >= 0');
        return options.version;
    }
    return file !== null && FILE_NAME_PATTERN.test(file) ? Number(file.slice(0, 4)) : null;
}

const exempt = (file, text) => PUBLISHED_EXEMPTIONS.some(entry => entry.file === file && entry.statement.toUpperCase() === text.toUpperCase());

function lintSql(sql, options = {}) {
    if (!options || typeof options !== 'object') throw new TypeError('lintSql options must be an object');
    if (options.file !== undefined && options.file !== null && typeof options.file !== 'string') throw new TypeError('file must be a string');
    const file = typeof options.file === 'string' ? options.file : null;
    const version = versionOf(options, file);
    const strict = version === null || version >= STRICT_FROM_VERSION;
    const { lineOf, stripped, tokens, split, statements } = analyse(sql);
    const found = [];
    for (const { rule, offset, quote } of stripped.problems) found.push({ offset, violation: { rule, file, line: lineOf(offset), quote } });
    for (const { rule, offset } of split.problems) found.push({ offset, violation: { rule, file, line: lineOf(offset) } });

    const exempted = [];
    for (const { first, last, trigger } of split.statements) {
        if (trigger) continue;
        const head = tokens[first];
        const keyword = KEYWORD_ALIASES.get(head.upper) || head.upper;
        if (!FORBIDDEN_KEYWORDS.includes(keyword)) continue;
        const text = tokenText(tokens, first, last);
        const violation = { rule: 'FORBIDDEN_STATEMENT', file, line: lineOf(head.offset), keyword, statement: shorten(text) };
        if (exempt(file, text)) exempted.push(violation);
        else found.push({ offset: head.offset, violation });
    }

    if (strict) {
        for (let index = 0; index < tokens.length; index += 1) {
            let phrase = null;
            if (isKeyword(tokens[index], 'ON') && isKeyword(tokens[index + 1], 'DELETE') && isKeyword(tokens[index + 2], 'CASCADE')) phrase = 'ON DELETE CASCADE';
            else if (isKeyword(tokens[index], 'SET') && isKeyword(tokens[index + 1], 'NULL')) phrase = 'SET NULL';
            else if (isKeyword(tokens[index], 'SET') && isKeyword(tokens[index + 1], 'DEFAULT')) phrase = 'SET DEFAULT';
            if (phrase !== null) {
                const { offset } = tokens[index];
                found.push({ offset, violation: { rule: 'FORBIDDEN_FOREIGN_KEY_ACTION', file, line: lineOf(offset), phrase } });
            }
        }
    }
    found.sort((a, b) => a.offset - b.offset); // stable, so equal offsets keep the order above
    return { file, version, strict, violations: found.map(entry => entry.violation), exempted, statements };
}

function lintFileNames(names) {
    if (!Array.isArray(names) || !names.every(name => typeof name === 'string')) throw new TypeError('lintFileNames needs an array of names');
    const violations = [];
    for (const name of names) {
        if (!FILE_NAME_PATTERN.test(name)) violations.push({ rule: 'FILE_NAME', file: name, detail: `does not match ${FILE_NAME_PATTERN}` });
    }
    const matching = names.filter(name => FILE_NAME_PATTERN.test(name)).sort(); // the order of loadMigrations
    if (matching.length === 0) violations.push({ rule: 'NOT_CONTIGUOUS', file: null, detail: 'no migration file' });
    matching.forEach((name, index) => {
        const version = Number(name.slice(0, 4));
        if (version !== index + 1) {
            violations.push({ rule: 'NOT_CONTIGUOUS', file: name, version, expected: index + 1, detail: `version ${version} where ${index + 1} is expected` });
        }
    });
    return { names: matching, violations };
}

function lintDirectory(directory = MIGRATIONS_DIRECTORY) {
    if (typeof directory !== 'string') throw new TypeError('lintDirectory needs a directory path');
    const entries = fs.readdirSync(directory, { withFileTypes: true })
        .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    const naming = lintFileNames(entries.map(entry => entry.name));
    const violations = [...naming.violations];
    const files = [];
    for (const entry of entries) {
        if (!FILE_NAME_PATTERN.test(entry.name)) continue;
        if (!entry.isFile()) {
            violations.push({ rule: 'FILE_NAME', file: entry.name, detail: 'is not a regular file' });
            continue;
        }
        const result = lintSql(fs.readFileSync(path.join(directory, entry.name), 'utf8'), { file: entry.name });
        files.push({ name: entry.name, version: result.version, strict: result.strict, violations: result.violations,
            exempted: result.exempted, statements: result.statements });
        violations.push(...result.violations);
    }
    return { directory, files, violations, exempted: files.flatMap(file => file.exempted) };
}

function formatViolation(violation) {
    const place = [violation.file, violation.line].filter(part => part !== null && part !== undefined).join(':') || '(text)';
    const what = violation.keyword || violation.phrase || violation.quote || violation.detail || '';
    const statement = violation.statement ? ` (${violation.statement})` : '';
    return `${place}: ${violation.rule}${what ? ` ${what}` : ''}${statement}`;
}

module.exports = {
    MIGRATIONS_DIRECTORY,
    FILE_NAME_PATTERN,
    STRICT_FROM_VERSION,
    FORBIDDEN_KEYWORDS,
    FORBIDDEN_FOREIGN_KEY_ACTIONS,
    PUBLISHED_EXEMPTIONS,
    RULES,
    lintSql,
    lintFileNames,
    lintDirectory,
    stripSql,
    splitStatements,
    formatViolation,
};
