// T-5B-10 (DB5-R15.6, NFR-07). Seeded pseudo-random generator and property runner for the DATA tests.
//
// DATA has no property-testing library and adds none (NFR-09). This helper is the only source of randomness of a
// generated-input test. It never calls the built-in random function, never reads the clock and opens no connection,
// so one seed always gives one sequence, on Windows and on Linux.
//
// createRandom(seed) returns a mulberry32 generator (32-bit state) for a seed from 0 to 4294967295:
//   int(min, max)              an integer from min to max, both included; max - min may reach 2^53 - 1
//   bool(p = 0.5)              true with probability p (0 <= p <= 1)
//   pick(list)                 one element of a non-empty array
//   weighted(pairs)            the value of one [value, weight] pair, drawn in proportion to the weights (>= 0)
//   shuffle(list)              a new array with the elements of list in random order; list itself is not changed
//   string(alphabet, min, max) min to max characters drawn from alphabet (a string split by code point, or an array)
//   bytes(n)                   a Buffer of n random bytes
//   fork(label)                an independent generator derived from this generator's seed and the label. It does not
//                              advance this generator, and the same label always gives the same generator, so use one
//                              label per stream (for example `op-${index}`).
//   seed                       the seed the generator was created with
// Every drawing function consumes the same number of 32-bit outputs for the same arguments and state.
//
// forAll(id, { runs, seed }, generate, check) runs `runs` cases (default 100; the calling file keeps its own count as a
// named constant). Run r draws from createRandom(deriveRunSeed(seed, r)): generate(random, info) builds the case, then
// check(value, info) tests it. Both may be async. A check fails by throwing, by rejecting or by returning false.
// info is { property, seed, run, runSeed, line, random }; info.random is the generator that generate used, so a check
// may keep drawing from it, and a check may append the operations it draws to the generated array.
// On the first failure forAll prints, through options.log (stderr by default), one line
//   property=<id> seed=<base> run=<index> runSeed=<n>
// followed by the operation list (options.describe; by default one line per element of a generated array), and rejects
// with a PropertyFailure whose message holds the same text and whose cause is the original error. Print labels only,
// never secrets. There is no shrinking: the operation list is the aid for reducing a failure by hand.
// Other options: env (default process.env) supplies the replay variables; onRun(line, info) is called before each run,
// for example `line => t.diagnostic(line)` for a property that prints the seed of every sequence (P-01, P-12).
//
// Replay one run: PROPERTY_SEED=<base> PROPERTY_RUN=<index> node --test tests/<file> in DATA/ (PowerShell: set
// $env:PROPERTY_SEED and $env:PROPERTY_RUN first). PROPERTY_SEED replaces the base seed of every forAll in the file, and
// PROPERTY_RUN runs that one index (also an index at or above `runs`) instead of runs 0 to runs - 1.
'use strict';

const { inspect } = require('node:util');

const DEFAULT_RUNS = 100;
const UINT32_MAX = 0xffffffff;
const MAX_RUN = 0xfffffffe;
const TWO_32 = 0x100000000;
const TWO_53 = 0x20000000000000;

function integerIn(value, min, max, name) {
    if (!Number.isSafeInteger(value)) throw new TypeError(`${name} must be a safe integer`);
    if (value < min || value > max) throw new RangeError(`${name} must be an integer from ${min} to ${max}`);
    return value;
}

// The 32-bit finaliser of MurmurHash3, a bijection on 32-bit integers.
function fmix32(value) {
    let hash = value >>> 0;
    hash = Math.imul(hash ^ (hash >>> 16), 0x85ebca6b);
    hash = Math.imul(hash ^ (hash >>> 13), 0xc2b2ae35);
    return (hash ^ (hash >>> 16)) >>> 0;
}

// FNV-1a over the UTF-8 bytes of a label.
function fnv1a(text) {
    let hash = 0x811c9dc5;
    for (const byte of Buffer.from(text, 'utf8')) hash = Math.imul(hash ^ byte, 0x01000193);
    return hash >>> 0;
}

// Run seed of run `run` under base seed `seed`. Both multipliers are odd, so for one base seed distinct runs give
// distinct run seeds. The formula is the one of the inline P-29 generator in baseline-checksums.test.js (T-5B-05), so
// moving that test to this helper keeps its run seeds.
function deriveRunSeed(seed, run) {
    integerIn(seed, 0, UINT32_MAX, 'seed');
    integerIn(run, 0, MAX_RUN, 'run');
    return (Math.imul(seed ^ 0x9e3779b9, 0x85ebca6b) + Math.imul(run + 1, 0xc2b2ae35)) >>> 0;
}

const seedLine = (id, seed, run, runSeed) => `property=${id} seed=${seed} run=${run} runSeed=${runSeed}`;

function createRandom(seed) {
    integerIn(seed, 0, UINT32_MAX, 'seed');
    let state = seed;
    // mulberry32 (Tommy Ettinger, public domain): one 32-bit output per call.
    const uint32 = () => {
        state = (state + 0x6d2b79f5) >>> 0;
        let value = Math.imul(state ^ (state >>> 15), state | 1);
        value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
        return (value ^ (value >>> 14)) >>> 0;
    };
    const unit = () => uint32() / TWO_32;

    function int(min, max) {
        if (!Number.isSafeInteger(min) || !Number.isSafeInteger(max)) throw new TypeError('int(min, max) needs safe integers');
        if (min > max) throw new RangeError('int(min, max) needs min <= max');
        if (max - min > Number.MAX_SAFE_INTEGER) throw new RangeError('int(min, max) needs max - min <= 2^53 - 1');
        const span = max - min + 1;
        // One output for spans up to 2^32 (the same mapping as the inline P-29 generator).
        if (span <= TWO_32) return min + Math.floor(unit() * span);
        // Wider spans: 53 bits from two outputs and rejection, so every value is reachable and none falls outside.
        const limit = TWO_53 - (TWO_53 % span);
        for (;;) {
            const high = uint32() >>> 11;
            const value = high * TWO_32 + uint32();
            if (value < limit) return min + (value % span);
        }
    }

    function bool(p = 0.5) {
        if (typeof p !== 'number' || !(p >= 0 && p <= 1)) throw new RangeError('bool(p) needs a number from 0 to 1');
        return unit() < p;
    }

    function pick(list) {
        if (!Array.isArray(list) || list.length === 0) throw new TypeError('pick(list) needs a non-empty array');
        return list[int(0, list.length - 1)];
    }

    function weighted(pairs) {
        if (!Array.isArray(pairs) || pairs.length === 0) throw new TypeError('weighted(pairs) needs a non-empty array of [value, weight] pairs');
        let total = 0;
        for (const pair of pairs) {
            if (!Array.isArray(pair) || pair.length !== 2) throw new TypeError('weighted(pairs) needs [value, weight] pairs');
            if (typeof pair[1] !== 'number' || !Number.isFinite(pair[1]) || pair[1] < 0) throw new RangeError('a weight must be a finite number >= 0');
            total += pair[1];
        }
        if (!(total > 0) || !Number.isFinite(total)) throw new RangeError('weighted(pairs) needs a finite positive total weight');
        let point = unit() * total;
        let last;
        for (const [value, weight] of pairs) {
            if (weight === 0) continue;
            if (point < weight) return value;
            point -= weight;
            last = value;
        }
        return last; // floating-point rounding only: the last pair with a positive weight
    }

    function shuffle(list) {
        if (!Array.isArray(list)) throw new TypeError('shuffle(list) needs an array');
        const result = [...list];
        for (let index = result.length - 1; index > 0; index -= 1) {
            const other = int(0, index);
            [result[index], result[other]] = [result[other], result[index]];
        }
        return result;
    }

    function string(alphabet, min, max) {
        const characters = typeof alphabet === 'string' ? Array.from(alphabet) : alphabet;
        if (!Array.isArray(characters) || characters.length === 0 || !characters.every(item => typeof item === 'string' && item.length > 0)) {
            throw new TypeError('string(alphabet, min, max) needs a non-empty string or array of non-empty strings');
        }
        integerIn(min, 0, Number.MAX_SAFE_INTEGER, 'min');
        integerIn(max, min, Number.MAX_SAFE_INTEGER, 'max');
        const length = int(min, max);
        let text = '';
        for (let index = 0; index < length; index += 1) text += characters[int(0, characters.length - 1)];
        return text;
    }

    function bytes(n) {
        integerIn(n, 0, Number.MAX_SAFE_INTEGER, 'n');
        const buffer = Buffer.alloc(n);
        for (let offset = 0; offset < n; offset += 4) {
            let value = uint32();
            for (let index = offset; index < Math.min(offset + 4, n); index += 1) {
                buffer[index] = value & 0xff;
                value >>>= 8;
            }
        }
        return buffer;
    }

    function fork(label) {
        if (typeof label !== 'string') throw new TypeError('fork(label) needs a string label');
        return createRandom(fmix32((seed ^ fnv1a(label)) >>> 0));
    }

    return Object.freeze({ seed, int, bool, pick, weighted, shuffle, string, bytes, fork });
}

class PropertyFailure extends Error {
    constructor(message, details, cause) {
        super(message, { cause });
        this.name = 'PropertyFailure';
        Object.assign(this, details);
    }
}

const show = value => inspect(value, { depth: 6, breakLength: Infinity, compact: true, maxArrayLength: 200, maxStringLength: 500 });

function defaultDescribe(value) {
    if (!Array.isArray(value)) return [show(value)];
    return value.length ? value.map((entry, index) => `${index}: ${show(entry)}`) : ['(no operations)'];
}

function describeCase(describe, value, info) {
    try {
        const described = describe(value, info);
        return (Array.isArray(described) ? described : [described]).map(String);
    } catch (error) {
        return [`(describe failed: ${error && error.message ? error.message : String(error)})`];
    }
}

function replaySetting(env, name, max) {
    const raw = env[name];
    if (raw === undefined || raw === '') return null;
    if (typeof raw !== 'string' || !/^\d{1,10}$/.test(raw) || Number(raw) > max) throw new RangeError(`${name} must be an integer from 0 to ${max}`);
    return Number(raw);
}

const writeLine = line => { process.stderr.write(`${line}\n`); };

async function forAll(id, options, generate, check) {
    if (typeof id !== 'string' || !/^[\x21-\x7e]+$/.test(id)) throw new TypeError('forAll needs a property id of printable ASCII characters without spaces');
    if (!options || typeof options !== 'object') throw new TypeError('forAll needs an options object with a seed');
    if (typeof generate !== 'function' || typeof check !== 'function') throw new TypeError('forAll needs generate and check functions');
    const { runs = DEFAULT_RUNS, env = process.env, log = writeLine, onRun = null, describe = defaultDescribe } = options;
    integerIn(options.seed, 0, UINT32_MAX, 'seed');
    integerIn(runs, 1, MAX_RUN + 1, 'runs');
    if (!env || typeof env !== 'object') throw new TypeError('env must be an object');
    if (typeof log !== 'function' || typeof describe !== 'function' || (onRun !== null && typeof onRun !== 'function')) {
        throw new TypeError('log, describe and onRun must be functions');
    }
    const override = replaySetting(env, 'PROPERTY_SEED', UINT32_MAX);
    const replay = replaySetting(env, 'PROPERTY_RUN', MAX_RUN);
    const seed = override === null ? options.seed : override;
    const count = replay === null ? runs : 1;

    for (let index = 0; index < count; index += 1) {
        const run = replay === null ? index : replay;
        const runSeed = deriveRunSeed(seed, run);
        const line = seedLine(id, seed, run, runSeed);
        const random = createRandom(runSeed);
        const info = Object.freeze({ property: id, seed, run, runSeed, line, random });
        if (onRun) onRun(line, info);
        let generated = false;
        let value;
        try {
            value = await generate(random, info);
            generated = true;
            if (await check(value, info) === false) throw new Error('check returned false');
        } catch (error) {
            const operations = generated ? describeCase(describe, value, info) : ['(generation failed)'];
            log(line);
            for (const entry of operations) log(`  ${entry}`);
            const reason = error instanceof Error ? error.message : String(error);
            throw new PropertyFailure([line, ...operations.map(entry => `  ${entry}`), reason].join('\n'),
                { property: id, seed, run, runSeed, line, operations }, error);
        }
    }
    return { property: id, seed, runs: count, replay };
}

module.exports = { DEFAULT_RUNS, createRandom, deriveRunSeed, seedLine, forAll, PropertyFailure };
