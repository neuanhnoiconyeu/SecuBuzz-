// T-5B-11 (DB5-R14.1, DB5-R14.5, DB5-R14.11; design DC-07, "Compatibility with the Migration_Runner rules", P-29).
// Tests of the migration lint helper tests/support/migration-lint.js and the lint of the real migration directory.
// Every SQL text here is a string in memory; the migration files are only read. No file is written and no database
// is opened. The real-directory test lints every file in server/database/migrations, so a later 0008 or 0009 is
// checked by the rules of version 8 and later without an edit of this file.
//
// Generated texts: replay one run with PROPERTY_SEED=<seed> PROPERTY_RUN=<run> node --test tests/migration-lint.test.js
// in DATA/ (PowerShell: set $env:PROPERTY_SEED and $env:PROPERTY_RUN first).
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { forAll } = require('./support/random');
const lint = require('./support/migration-lint');

// OP-07 (provisional default, reported in the DB-5B handoff): generated SQL texts of the P-29 lint property.
const LINT_PROPERTY_RUNS = 200;
const LINT_PROPERTY_SEED = 29110;

const LINT_FILE = require.resolve('./support/migration-lint');
const MIGRATIONS = path.join(__dirname, '..', 'server', 'database', 'migrations');
const migrationNames = () => fs.readdirSync(MIGRATIONS).filter(name => /^\d{4}-[a-z0-9-]+\.sql$/.test(name)).sort();
const nextMigrationName = (label, offset = 1) => `${String(migrationNames().length + offset).padStart(4, '0')}-${label}.sql`;
const PUBLISHED = Object.freeze(migrationNames());
const rulesOf = result => result.violations.map(violation => violation.rule);
const statementHits = result => result.violations.filter(v => v.rule === 'FORBIDDEN_STATEMENT').map(v => [v.keyword, v.line]);

// ---------------------------------------------------------------------------------------------------------------
// Hand-written cases.
// ---------------------------------------------------------------------------------------------------------------
test('lint: each forbidden statement alone is reported with its keyword, also in lower case and without a final semicolon', () => {
    const cases = [
        ['BEGIN;', 'BEGIN'], ['begin immediate transaction;', 'BEGIN'], ['COMMIT;', 'COMMIT'], ['commit transaction', 'COMMIT'],
        ['End Transaction;', 'COMMIT'], ['ROLLBACK;', 'ROLLBACK'], ['rollback to savepoint s1;', 'ROLLBACK'], ['VACUUM;', 'VACUUM'],
        ["vacuum into 'copy';", 'VACUUM'], ["ATTACH DATABASE ':memory:' AS aux;", 'ATTACH'], ['PRAGMA foreign_keys = OFF;', 'PRAGMA'],
        ['pragma journal_mode', 'PRAGMA'],
    ];
    for (const [sql, keyword] of cases) {
        assert.deepEqual(statementHits(lint.lintSql(sql)), [[keyword, 1]], sql);
        const framed = lint.lintSql(`CREATE TABLE t_a(x TEXT);\n-- note\n${sql}${sql.endsWith(';') ? '' : ';'}\nCREATE TABLE t_b(y TEXT);`, { version: 7 });
        assert.deepEqual(rulesOf(framed), ['FORBIDDEN_STATEMENT'], sql);
        assert.deepEqual(statementHits(framed), [[keyword, 3]], sql);
    }
});

test('lint: a keyword only inside a string, a comment or a quoted identifier is not reported, and begin_at is a plain name', () => {
    const accepted = [
        "SELECT 'BEGIN; COMMIT; ROLLBACK; VACUUM; ATTACH x AS y; PRAGMA a = b;';",
        "INSERT INTO t(note) VALUES('it''s; PRAGMA foreign_keys = OFF; -- not a comment');",
        '-- BEGIN;\n-- COMMIT;\nCREATE TABLE t(x TEXT);',
        '/* PRAGMA foreign_keys = OFF;\n   VACUUM; */ CREATE TABLE t(x TEXT);',
        "-- it's a comment with ' and /* in it\nCREATE TABLE t(x TEXT);",
        "/* a ' or \" or ` or [ in a block comment */ CREATE TABLE t(x TEXT);",
        'CREATE TABLE "BEGIN"("COMMIT" TEXT, [ROLLBACK;] TEXT, `PRAGMA` TEXT, "we""ird; VACUUM" TEXT, `back``tick; ATTACH` TEXT);',
        'CREATE TABLE begin_log(begin_at TEXT, commit_id TEXT, pragma_value TEXT, vacuum_count INTEGER, attach_ref TEXT, end_at TEXT);',
        'CREATE INDEX idx_begin_at ON begin_log(begin_at);\nALTER TABLE begin_log ADD COLUMN rollback_note TEXT;',
        "CREATE VIEW v AS SELECT CASE WHEN begin_at IS NULL THEN 'END' END AS phase FROM begin_log;",
        'CREATE TABLE t(x TEXT);;\n;',
    ];
    for (const sql of accepted) {
        const result = lint.lintSql(sql);
        assert.deepEqual(result.violations, [], sql);
        assert.deepEqual(result.exempted, [], sql);
    }
    assert.deepEqual(lint.stripSql("SELECT 'a;b' -- c\nX").text, `SELECT${' '.repeat(11)}\nX`, 'same length, line breaks kept');
});

test('lint: CREATE [TEMP] TRIGGER bodies are ignored, nested CASE ... END included, and the statement after a body is linted', () => {
    const sql = [
        'CREATE TRIGGER t_ins BEFORE INSERT ON t BEGIN',
        "    SELECT CASE WHEN NEW.x IS NULL THEN RAISE(ABORT,'x') ELSE CASE WHEN NEW.end IS NULL THEN 1 END END;",
        "    SELECT RAISE(ROLLBACK, 'END');",
        '    PRAGMA foreign_keys = OFF; -- END;',
        'END;',
        'CREATE TEMP TRIGGER t_upd AFTER UPDATE OF begin_at ON t WHEN CASE WHEN NEW.y THEN 1 END = 1 BEGIN UPDATE t SET begin_at = NULL; END;',
        'create temporary trigger if not exists "begin" after delete on t begin delete from u; commit; end',
        'COMMIT;',
    ].join('\n');
    const result = lint.lintSql(sql, { version: 7 });
    assert.deepEqual(result.violations.map(v => [v.rule, v.keyword, v.line]), [['FORBIDDEN_STATEMENT', 'COMMIT', 8]]);
    assert.deepEqual(result.statements.map(s => [s.trigger, s.line, s.body && [s.body.line, s.body.endLine]]),
        [[true, 1, [1, 5]], [true, 6, [6, 6]], [true, 7, [7, 7]], [false, 8, null]]);

    // Text the lint cannot delimit is reported, so a statement behind it cannot pass unseen.
    assert.deepEqual(rulesOf(lint.lintSql('CREATE TRIGGER t1 AFTER INSERT ON t BEGIN SELECT CASE WHEN 1 THEN 2 END;\nCOMMIT;')), ['UNTERMINATED_TRIGGER']);
    assert.deepEqual(rulesOf(lint.lintSql("CREATE TABLE t(x TEXT DEFAULT 'open);\nCOMMIT;")), ['UNTERMINATED_LITERAL']);
    assert.deepEqual(rulesOf(lint.lintSql('CREATE TABLE "t(x TEXT);\nCOMMIT;')), ['UNTERMINATED_LITERAL']);
    assert.deepEqual(rulesOf(lint.lintSql('CREATE TRIGGER t1 AFTER INSERT ON t BEGIN SELECT 1; END PRAGMA foreign_keys = OFF;')), ['FORBIDDEN_STATEMENT']);
});

test('lint: ON DELETE CASCADE, SET NULL and SET DEFAULT are reported from version 8 on, never inside strings or comments', () => {
    const sql = [
        'CREATE TABLE a(x TEXT REFERENCES Users(user_id) ON DELETE CASCADE,',
        '    y TEXT REFERENCES Users(user_id) on delete set null ON UPDATE SET DEFAULT,',
        "    z TEXT DEFAULT 'ON DELETE CASCADE' REFERENCES Users(user_id) ON DELETE RESTRICT); -- SET NULL",
        'UPDATE a SET x = NULL WHERE y IS NULL;',
    ].join('\n');
    const actions = result => result.violations.map(v => [v.rule, v.phrase, v.line]);
    const expected = [['FORBIDDEN_FOREIGN_KEY_ACTION', 'ON DELETE CASCADE', 1], ['FORBIDDEN_FOREIGN_KEY_ACTION', 'SET NULL', 2],
        ['FORBIDDEN_FOREIGN_KEY_ACTION', 'SET DEFAULT', 2]];
    assert.deepEqual(actions(lint.lintSql(sql, { version: 8 })), expected);
    assert.deepEqual(actions(lint.lintSql(sql, { file: '0008-groups.sql' })), expected);
    assert.deepEqual(actions(lint.lintSql(sql)), expected, 'without a version the rules of version 8 and later apply');
    assert.deepEqual(lint.lintSql(sql, { version: 7 }).violations, []);
    assert.deepEqual(lint.lintSql(sql, { file: '0007-recipient-keys.sql' }).violations, []);
    assert.equal(lint.lintSql(sql, { file: '0012-later.sql' }).strict, true);
});

test('lint: file names outside ^\\d{4}-[a-z0-9-]+\\.sql$ and versions that are not contiguous from 1 are reported', () => {
    assert.deepEqual(lint.lintFileNames([...PUBLISHED]).violations, []);
    assert.deepEqual(lint.lintFileNames([...PUBLISHED, nextMigrationName('future-one'), nextMigrationName('future-two', 2)]).violations, []);
    assert.deepEqual(lint.lintFileNames([...PUBLISHED].reverse()).names, PUBLISHED, 'names are taken in runner order');
    const cases = [
        [[nextMigrationName('Groups')], [['FILE_NAME', nextMigrationName('Groups')]]],
        [[nextMigrationName('bad_name')], [['FILE_NAME', nextMigrationName('bad_name')]]],
        [[nextMigrationName('groups', 1).replace('.sql', '.SQL')], [['FILE_NAME', nextMigrationName('groups', 1).replace('.sql', '.SQL')]]],
        [['8-groups.sql'], [['FILE_NAME', '8-groups.sql']]],
        [['0008-groups.sql.txt'], [['FILE_NAME', '0008-groups.sql.txt']]],
        [['README.md'], [['FILE_NAME', 'README.md']]],
        [[nextMigrationName('future', 2)], [['NOT_CONTIGUOUS', nextMigrationName('future', 2)]]],
        [[nextMigrationName('groups', 1), nextMigrationName('other', 1)], [['NOT_CONTIGUOUS', nextMigrationName('other', 1)]]],
    ];
    for (const [extra, expected] of cases) {
        assert.deepEqual(lint.lintFileNames([...PUBLISHED, ...extra]).violations.map(v => [v.rule, v.file]), expected, extra.join(','));
    }
    assert.deepEqual(lint.lintFileNames(['0002-foundation.sql']).violations.map(v => [v.rule, v.version, v.expected]), [['NOT_CONTIGUOUS', 2, 1]]);
    assert.deepEqual(rulesOf(lint.lintFileNames([])), ['NOT_CONTIGUOUS']);
});

test('lint: the 0001 exemption covers exactly PRAGMA foreign_keys = ON in 0001-legacy.sql', () => {
    const accepted = lint.lintSql('\nPRAGMA foreign_keys = ON;\nCREATE TABLE t(x TEXT);', { file: '0001-legacy.sql' });
    assert.deepEqual(accepted.violations, []);
    assert.deepEqual(accepted.exempted.map(e => [e.rule, e.keyword, e.line, e.statement]), [['FORBIDDEN_STATEMENT', 'PRAGMA', 2, 'PRAGMA foreign_keys = ON']]);
    const refused = [
        ['PRAGMA foreign_keys = OFF;', { file: '0001-legacy.sql' }],
        ['PRAGMA journal_mode = WAL;', { file: '0001-legacy.sql' }],
        ['COMMIT;', { file: '0001-legacy.sql' }],
        ['PRAGMA foreign_keys = ON;', { file: '0008-groups.sql' }],
        ['PRAGMA foreign_keys = ON;', {}],
    ];
    for (const [sql, options] of refused) assert.deepEqual(rulesOf(lint.lintSql(sql, options)), ['FORBIDDEN_STATEMENT'], `${sql} ${JSON.stringify(options)}`);
});

test('lint helper reads only: fs listing and reading, no other module, no database, ASCII source', () => {
    const source = fs.readFileSync(LINT_FILE, 'utf8');
    assert.deepEqual([...new Set(source.match(/\bfs\.\w+/g))].sort(), ['fs.readFileSync', 'fs.readdirSync']);
    assert.deepEqual([...source.matchAll(/require\(([^)]*)\)/g)].map(match => match[1]).sort(), ["'node:fs'", "'node:path'"]);
    assert.doesNotMatch(source, /better-sqlite3|new Database|\.prepare\(|\.exec\(|Math\.random|Date\.now|process\.env/);
    for (const file of [LINT_FILE, __filename]) assert.match(fs.readFileSync(file, 'utf8'), /^[\x00-\x7f]*$/, `${path.basename(file)} is ASCII`);
});

// ---------------------------------------------------------------------------------------------------------------
// The real migration directory.
// ---------------------------------------------------------------------------------------------------------------
test('lint of server/database/migrations: 0001 to 0007 pass (DC-07) and every file from 0008 on meets the rules of version 8 and later', () => {
    const result = lint.lintDirectory();
    assert.equal(path.resolve(result.directory), path.resolve(MIGRATIONS));
    assert.deepEqual(result.violations.map(lint.formatViolation), []);
    assert.deepEqual(result.files.map(file => file.name).slice(0, PUBLISHED.length), [...PUBLISHED]);
    for (const file of result.files) assert.equal(file.strict, file.version >= lint.STRICT_FROM_VERSION, file.name);
    assert.deepEqual(result.exempted.map(e => [e.file, e.line, e.keyword, e.statement]), [['0001-legacy.sql', 2, 'PRAGMA', 'PRAGMA foreign_keys = ON']]);

    // DC-07: the published files hold trigger bodies with BEGIN ... END and CASE ... END. Every CREATE TRIGGER of them
    // gets a delimited body, and a COMMIT appended after the last statement is still found, so no body swallows text.
    let triggers = 0;
    for (const file of result.files.filter(entry => PUBLISHED.includes(entry.name))) {
        const text = fs.readFileSync(path.join(MIGRATIONS, file.name), 'utf8');
        const written = (text.match(/\bCREATE\s+(?:TEMP\s+|TEMPORARY\s+)?TRIGGER\b/gi) || []).length;
        assert.equal(file.statements.filter(statement => statement.trigger && statement.body).length, written, file.name);
        triggers += written;
        const appended = lint.lintSql(`${text}\nCOMMIT;\n`, { file: file.name });
        assert.deepEqual(statementHits(appended), [['COMMIT', text.split('\n').length + 1]], file.name);
    }
    assert.ok(triggers > 0, 'the published migrations contain trigger bodies');
});

// ---------------------------------------------------------------------------------------------------------------
// P-29 (lint clauses): generated SQL texts. The generator knows where it put each forbidden statement: at the top
// level (a violation) or inside a trigger body (no violation), and it hides forbidden words in strings, comments,
// quoted identifiers, names such as begin_at, qualified names such as NEW.end, and nested CASE ... END expressions.
// ---------------------------------------------------------------------------------------------------------------
const COLUMNS = ['begin_at', 'end_at', 'commit_id', 'pragma_value', 'vacuum_count', 'attach_ref', 'rollback_note', 'case_no', 'note'];
const TABLES = ['begin_log', 'commit_queue', 'pragma_cache', 'end_marks', 'attach_refs', 'vacuum_stats', 'rollback_notes'];
const STRINGS = ["'BEGIN; COMMIT;'", "'it''s END; -- not a comment'", "'/* VACUUM; */'", "'PRAGMA foreign_keys = OFF;'", "'ON DELETE CASCADE'",
    "'SET NULL'", "''", "'ATTACH DATABASE x AS y; ROLLBACK'", "'CASE END END'"];
const QUOTED = ['"BEGIN"', '"we""ird COMMIT"', '[END]', '`PRAGMA`', '`back``tick VACUUM`', '"case"', '[ROLLBACK;]'];
const COMMENTS = ["-- BEGIN; COMMIT; it's fine\n", '/* PRAGMA foreign_keys = OFF; END; */ ', '-- ROLLBACK /* never closed here\n',
    "/* -- VACUUM; ' \" ` [ */ ", '/* multi\nline\nATTACH x AS y; */\n', '-- ON DELETE CASCADE SET NULL\n'];
const FORBIDDEN = [
    ['BEGIN', ['BEGIN', 'BEGIN TRANSACTION', 'BEGIN IMMEDIATE', 'BEGIN DEFERRED TRANSACTION', 'BEGIN EXCLUSIVE']],
    ['COMMIT', ['COMMIT', 'COMMIT TRANSACTION']],
    ['ROLLBACK', ['ROLLBACK', 'ROLLBACK TRANSACTION', 'ROLLBACK TO SAVEPOINT sp_1', 'ROLLBACK TO sp_2']],
    ['VACUUM', ['VACUUM', 'VACUUM main', "VACUUM INTO 'copy'"]],
    ['ATTACH', ["ATTACH DATABASE ':memory:' AS aux_1", "ATTACH 'other' AS aux_2"]],
    ['PRAGMA', ['PRAGMA foreign_keys = OFF', 'PRAGMA foreign_keys = ON', 'PRAGMA journal_mode', 'PRAGMA main.user_version = 8', "PRAGMA encoding = 'UTF-8'"]],
];

// Upper, lower or mixed case of every word made of letters only; other words (names, literals) stay as written.
function phrase(random, text) {
    return text.split(' ').map(word => {
        if (!/^[A-Za-z]+$/.test(word)) return word;
        const mode = random.int(0, 2);
        if (mode === 0) return word.toUpperCase();
        if (mode === 1) return word.toLowerCase();
        return Array.from(word, letter => (random.bool() ? letter.toUpperCase() : letter.toLowerCase())).join('');
    }).join(' ');
}

function forbiddenStatement(random) {
    const [keyword, forms] = random.pick(FORBIDDEN);
    return { keyword, text: phrase(random, random.pick(forms)) };
}

function caseExpression(random, depth) {
    const nested = () => (depth > 0 && random.bool(0.6) ? caseExpression(random, depth - 1) : null);
    const condition = nested();
    const value = nested();
    const when = condition === null ? random.pick(['NEW.begin_at IS NULL', "NEW.note = 'COMMIT;'", 'NEW.end IS NOT NULL', 'OLD.end_at <> NEW.end_at'])
        : `(${condition}) = 1`;
    const then = value === null ? random.pick(["RAISE(ABORT, 'END')", 'NULL', '1', "'CASE END'", 'NEW.begin_at']) : value;
    const otherwise = random.bool(0.4) ? ` ${phrase(random, 'ELSE')} ${random.pick(['0', "'BEGIN'", 'NULL'])}` : '';
    return `${phrase(random, 'CASE WHEN')} ${when} ${phrase(random, 'THEN')} ${then}${otherwise} ${phrase(random, 'END')}`;
}

function bodyStatement(random) {
    const table = random.pick(TABLES);
    const column = random.pick(COLUMNS);
    const make = random.weighted([
        [() => `${phrase(random, 'SELECT')} ${caseExpression(random, random.int(0, 3))};`, 4],
        [() => `${phrase(random, 'UPDATE')} ${table} ${phrase(random, 'SET')} ${column} = NEW.${column}, note = ${random.pick(STRINGS)} WHERE ${column} = OLD.${column};`, 2],
        [() => `${phrase(random, 'INSERT INTO')} ${table}(note) ${phrase(random, 'VALUES')} (${random.pick(STRINGS)});`, 2],
        [() => `${phrase(random, 'DELETE FROM')} ${table} WHERE NEW.end IS NULL;`, 1],
        [() => `SELECT RAISE(${phrase(random, 'ROLLBACK')}, ${random.pick(STRINGS)});`, 1],
        [() => `${forbiddenStatement(random).text};`, 2], // inside the body: ignored by the lint
        [() => `${random.pick(COMMENTS)}SELECT 1;`, 1],
    ]);
    return make();
}

function triggerStatement(random) {
    const temporary = random.pick(['', 'TEMP ', 'TEMPORARY ']);
    const ifNotExists = random.bool(0.3) ? 'IF NOT EXISTS ' : '';
    const name = random.bool(0.7) ? `trg_${random.pick(TABLES)}_${random.int(0, 99)}` : random.pick(QUOTED);
    const event = random.pick(['INSERT', 'DELETE', 'UPDATE', `UPDATE OF ${random.pick(COLUMNS)}, ${random.pick(COLUMNS)}`]);
    const forEachRow = random.bool(0.3) ? ` ${phrase(random, 'FOR EACH ROW')}` : '';
    const when = random.bool(0.4)
        ? ` ${phrase(random, 'WHEN')} ${random.bool() ? `${caseExpression(random, random.int(0, 2))} = 1` : "NEW.note <> 'BEGIN'"}` : '';
    const separator = random.pick([' ', '\n    ', '\r\n    ']);
    const body = Array.from({ length: random.int(1, 4) }, () => bodyStatement(random));
    return `${phrase(random, `CREATE ${temporary}TRIGGER ${ifNotExists}`)}${name} ${phrase(random, `${random.pick(['BEFORE', 'AFTER'])} ${event} ON`)} `
        + `${random.pick(TABLES)}${forEachRow}${when} ${phrase(random, 'BEGIN')}${separator}${body.join(separator)}${separator}${phrase(random, 'END')}`;
}

function createTable(random, fk) {
    const columns = Array.from({ length: random.int(1, 4) }, () => {
        let column = `${random.bool(0.7) ? random.pick(COLUMNS) : random.pick(QUOTED)} ${random.pick(['TEXT', 'INTEGER'])}`;
        if (random.bool(0.4)) column += ` ${phrase(random, 'DEFAULT')} ${random.pick(STRINGS)}`;
        if (random.bool(0.6)) {
            const onDelete = random.weighted([['RESTRICT', 5], ['CASCADE', 1], ['SET NULL', 1], ['SET DEFAULT', 1]]);
            column += ` ${phrase(random, 'REFERENCES')} Users(user_id) ${phrase(random, `ON DELETE ${onDelete}`)}`;
            if (onDelete !== 'RESTRICT') fk.push(onDelete === 'CASCADE' ? 'ON DELETE CASCADE' : onDelete);
            if (random.bool(0.3)) {
                const onUpdate = random.pick(['RESTRICT', 'NO ACTION', 'SET NULL', 'SET DEFAULT']);
                column += ` ${phrase(random, `ON UPDATE ${onUpdate}`)}`;
                if (onUpdate.startsWith('SET')) fk.push(onUpdate);
            }
        }
        return column;
    });
    return `${phrase(random, 'CREATE TABLE')} ${random.pick(TABLES)}_${random.int(0, 99)} (${columns.join(', ')})`;
}

function plainStatement(random, fk) {
    const table = random.pick(TABLES);
    const column = random.pick(COLUMNS);
    const make = random.weighted([
        [() => createTable(random, fk), 3],
        [() => `${phrase(random, 'CREATE INDEX')} idx_${table}_${column} ${phrase(random, 'ON')} ${table}(${column}) ${phrase(random, 'WHERE')} note <> ${random.pick(STRINGS)}`, 1],
        [() => `${phrase(random, 'INSERT INTO')} ${table}(${column}, note) ${phrase(random, 'SELECT')} ${column}, ${random.pick(STRINGS)} ${phrase(random, 'FROM')} ${random.pick(TABLES)}`, 1],
        [() => `${phrase(random, 'ALTER TABLE')} ${table} ${phrase(random, 'ADD COLUMN')} ${column} INTEGER NOT NULL DEFAULT 0`, 1],
        [() => `${phrase(random, 'UPDATE')} ${table} ${phrase(random, 'SET')} ${column} = NULL ${phrase(random, 'WHERE')} note IS NULL`, 1],
        [() => `${phrase(random, 'CREATE VIEW')} v_${table} ${phrase(random, 'AS SELECT')} ${caseExpression(random, random.int(0, 2))} AS phase FROM ${table}`, 1],
    ]);
    return make();
}

function generateCase(random) {
    const strict = random.bool();
    const version = strict ? random.int(lint.STRICT_FROM_VERSION, 9999) : random.int(1, lint.STRICT_FROM_VERSION - 1);
    const kinds = Array.from({ length: random.int(1, 10) }, () => random.pick(['plain', 'trigger']));
    if (random.bool()) for (let count = random.int(1, 3); count > 0; count -= 1) kinds.splice(random.int(0, kinds.length), 0, 'forbidden');
    let text = '';
    const expected = [];
    const fk = [];
    kinds.forEach((kind, index) => {
        if (random.bool(0.3)) text += random.pick(COMMENTS);
        if (random.bool(0.1)) text += ';';
        const line = text.split('\n').length;
        if (kind === 'forbidden') {
            const statement = forbiddenStatement(random);
            expected.push([statement.keyword, line]);
            text += statement.text;
        } else {
            text += kind === 'trigger' ? triggerStatement(random) : plainStatement(random, fk);
        }
        text += index === kinds.length - 1 && random.bool(0.3) ? '' : ';';
        text += random.pick(['\n', ' ', '\n\n', '\r\n', '\t']);
    });
    return { version, strict, kinds, text, expected, fk: strict ? fk : [] };
}

const describeCase = value => [`version=${value.version} kinds=${value.kinds.join(',')} expected=${JSON.stringify(value.expected)} fk=${JSON.stringify(value.fk)}`,
    ...value.text.split('\n').map((line, index) => `${index + 1}| ${line}`)];

// Feature: db5-db6-canonical-integration, Property P-29: Published migrations are immutable (lint clauses)
// **Validates: Requirements DB5-R14.1, DB5-R14.5, DB5-R14.11**
test('P-29 for generated SQL texts the lint reports a violation exactly when a forbidden statement lies outside a trigger body', async () => {
    let withViolation = 0;
    const summary = await forAll('P-29-lint', { runs: LINT_PROPERTY_RUNS, seed: LINT_PROPERTY_SEED, describe: describeCase }, generateCase, value => {
        const result = lint.lintSql(value.text, { version: value.version });
        assert.deepEqual(statementHits(result), value.expected, 'forbidden statements outside trigger bodies, with their lines');
        assert.equal(result.violations.some(v => v.rule === 'FORBIDDEN_STATEMENT'), value.expected.length > 0);
        assert.deepEqual(result.violations.filter(v => v.rule === 'FORBIDDEN_FOREIGN_KEY_ACTION').map(v => v.phrase), value.fk);
        assert.deepEqual(result.violations.filter(v => v.rule !== 'FORBIDDEN_STATEMENT' && v.rule !== 'FORBIDDEN_FOREIGN_KEY_ACTION'), []);
        assert.deepEqual(result.exempted, []);
        if (value.expected.length > 0) withViolation += 1;
    });
    if (summary.replay === null) {
        assert.equal(summary.runs, LINT_PROPERTY_RUNS);
        assert.ok(withViolation > 0 && withViolation < LINT_PROPERTY_RUNS, 'the generated texts include cases with and without a violation');
    }
});

test('migration 0009 is contiguous, strict, and contains no forbidden top-level statements or delete actions', () => {
    const result=lint.lintDirectory();
    assert.deepEqual(result.violations.map(lint.formatViolation),[]);
    assert.deepEqual(result.files.map(file=>file.name),Array.from({length:9},(_,index)=>`${String(index+1).padStart(4,'0')}-${migrationNames()[index].slice(5)}`));
    const entry=result.files.find(file=>file.name==='0009-attachment-lifecycle.sql');
    assert.ok(entry);assert.equal(entry.version,9);assert.equal(entry.strict,true);assert.deepEqual(entry.violations,[]);
    assert.doesNotMatch(fs.readFileSync(path.join(MIGRATIONS,'0009-attachment-lifecycle.sql'),'utf8'),/ON DELETE\s+(?:CASCADE|SET\s+(?:NULL|DEFAULT))/i);
});