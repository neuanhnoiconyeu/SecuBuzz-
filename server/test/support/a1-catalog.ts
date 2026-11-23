/** Test metadata only. No watermark engine, migration policy or runtime feature gate. */
export type A1Invariant = `I${1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 | 10}`;
export const a1Cases = [
  ['A01', 'I1,I2,I4'], ['A02', 'I1,I3,I4'], ['A03', 'I1,I3,I6,I10'],
  ['A04', 'I1,I8'], ['A05', 'I1,I2'], ['A06', 'I1,I2'], ['A07', 'I1,I8'],
  ['A08', 'I1,I3,I6,I8'], ['A09', 'I2,I5'], ['A10', 'I2,I5'], ['A11', 'I2'],
  ['A12', 'I1,I5'], ['A13', 'I3,I5'], ['A14', 'I2,I5'], ['A15', 'I1,I3'],
  ['A16', 'I3,I5,I8'], ['A17', 'I3,I5,I10'],
  ['M01', 'I6,I9'], ['M02', 'I1,I2,I6'], ['M03', 'I3,I6,I10'],
  ['M04', 'I6,I10'], ['M05', 'I4,I6,I10'], ['M06', 'I6,I10'],
  ['M07', 'I5,I6,I9,I10'], ['M08', 'I5,I6'], ['M09', 'I7'], ['M10', 'I7'],
  ['S01', 'I5,I6,I10'], ['S02', 'I6,I10'],
  ['C01', 'I4'], ['C02', 'I3,I4'], ['C03', 'I4,I5'],
  ['F01', 'I4,I8,I9'], ['F02', 'I4,I9'],
  ['R01', 'I3,I7,I9'], ['R02', 'I2,I9,I10'], ['R03', 'I9'],
] as const;
export type A1Case = typeof a1Cases[number][0];

interface FoundationCheck {
  id: string;
  kind: 'current' | 'platform-prerequisite' | 'known-failing';
  cases: readonly A1Case[];
  invariants: readonly A1Invariant[];
  title: string;
}

export const foundationChecks = [
  { id: 'P01', kind: 'current', cases: ['A01', 'A09', 'R01'], invariants: ['I1', 'I2'], title: 'same-alias edited rollback is rejected and latest valid text survives a reopened session' },
  { id: 'P02', kind: 'current', cases: ['A02', 'A13', 'A16'], invariants: ['I3', 'I5'], title: 'confirmed deletion retains the highest observed edit and rejects same-alias resurrection' },
  { id: 'P03', kind: 'current', cases: ['A12', 'A14'], invariants: ['I2', 'I5'], title: 'concurrent client/store connections cannot lower an already observed same-alias head' },
  { id: 'P04', kind: 'current', cases: ['A13', 'A14'], invariants: ['I3', 'I5'], title: 'racing valid edit reads and deletion observations end terminal in either scheduling order' },
  { id: 'P05', kind: 'current', cases: ['A07'], invariants: ['I1', 'I8'], title: 'a different logical message cannot borrow an occupied storage alias' },
  { id: 'P06', kind: 'current', cases: ['A09', 'A10', 'A11'], invariants: ['I2', 'I5'], title: 'a genuine signed losing concurrent edit cannot replace the already observed winning chain' },
  { id: 'P07', kind: 'current', cases: ['A06', 'A11'], invariants: ['I2'], title: 'rewritten authenticated wire identity fails before changing the saved head' },
  { id: 'P08', kind: 'current', cases: ['A03', 'M03'], invariants: ['I3', 'I6'], title: 'a legacy deletion-only observation is retained across sessions without fabricating a root' },
  { id: 'P09', kind: 'current', cases: ['A04'], invariants: ['I1'], title: 'account namespaces in one shared fixture database cannot consume each other\'s observations' },
  { id: 'P10', kind: 'current', cases: ['A11', 'R02'], invariants: ['I2', 'I8'], title: 'real DATA sender authorization and CSRF remain enforced for genuine encrypted edit requests' },
  { id: 'P11', kind: 'current', cases: ['M01', 'R01'], invariants: ['I9'], title: 'reopened client restores non-extractable device identity, nonce reservations and exact uncertain send bytes' },
  { id: 'P12', kind: 'platform-prerequisite', cases: ['A12', 'M08'], invariants: ['I5'], title: 'native Chrome serializes overlapping transactions from two tabs' },
  { id: 'P13', kind: 'platform-prerequisite', cases: ['A17', 'M07'], invariants: ['I5'], title: 'native request success followed by transaction abort publishes no committed fixture write' },
  { id: 'P14', kind: 'platform-prerequisite', cases: ['M07'], invariants: ['I6', 'I9'], title: 'an aborted generic fixture schema upgrade preserves its version and sentinel records' },
  { id: 'P15', kind: 'platform-prerequisite', cases: ['M09'], invariants: ['I7'], title: 'an old connection blocks a generic fixture upgrade and version-one reopen fails afterward' },
  { id: 'P16', kind: 'platform-prerequisite', cases: ['M10'], invariants: ['I7'], title: 'closing an old database handle does not erase an already cached synthetic value' },
  { id: 'E01', kind: 'known-failing', cases: ['A05', 'A07'], invariants: ['I1', 'I2', 'I8'], title: 'a valid conflicting original under a new alias must not replace an observed logical identity' },
] as const satisfies readonly FoundationCheck[];

export function foundationTitle(id: typeof foundationChecks[number]['id']): string {
  const row = foundationChecks.find(check => check.id === id)!;
  return `[${row.id}][${row.kind}][${row.cases.join(',')}][${row.invariants.join(',')}] ${row.title}`;
}
