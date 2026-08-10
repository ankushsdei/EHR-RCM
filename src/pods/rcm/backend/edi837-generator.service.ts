/**
 * EDI 837P generator — Task T15.
 *
 * Builds an ANSI X12 005010X222A1 (837 Professional) transaction from claim,
 * encounter, and billing data. Fully deterministic: all control numbers and
 * the interchange date/time are supplied by the caller, so output is
 * reproducible and testable. Segment counts (SE/GE/IEA) are computed, not
 * hard-coded.
 *
 * Acceptance (matrix T15): generates a valid X12 837 transaction set string.
 */

const ELEMENT = '*';
const SUBELEMENT = ':';
const SEG_TERM = '~';

export interface Party {
  name: string;
  id: string;
}

export interface BillingProvider {
  name: string;
  npi: string;
  taxId: string;
  address: { street: string; city: string; state: string; zip: string };
}

export interface Subscriber {
  firstName: string;
  lastName: string;
  memberId: string;
}

export interface ServiceLine {
  cpt: string;
  chargeCents: number;
  units: number;
  modifiers?: string[];
  /** Date of service, CCYYMMDD. */
  dateOfService: string;
  /** 1-based diagnosis pointer(s); defaults to [1]. */
  diagnosisPointers?: number[];
}

export interface ClaimData {
  /** Patient control number (our claim id). */
  id: string;
  totalChargeCents: number;
  placeOfService?: string; // default '11' (office)
  diagnoses: { code: string }[]; // ICD-10, principal first
  serviceLines: ServiceLine[];
}

export interface Interchange {
  senderId: string;
  receiverId: string;
  /** YYMMDD. */
  date: string;
  /** HHMM. */
  time: string;
  controlNumber: string; // 9 digits
  /** CCYYMMDD used in GS/BHT. */
  fullDate: string;
  usageIndicator?: 'P' | 'T'; // default 'P'
}

export interface Edi837Input {
  submitter: Party;
  receiver: Party;
  billingProvider: BillingProvider;
  subscriber: Subscriber;
  payer: Party;
  claim: ClaimData;
  interchange: Interchange;
  groupControlNumber: string;
  transactionControlNumber: string;
}

/** Format integer cents as a dollar amount string (X12 monetary). */
function money(cents: number): string {
  return (cents / 100).toFixed(2);
}

/** Pad/truncate a value to a fixed width (for ISA fixed fields). */
function fixed(value: string, width: number): string {
  return value.length >= width ? value.slice(0, width) : value.padEnd(width, ' ');
}

function seg(...elements: (string | number)[]): string {
  return elements.map((e) => String(e)).join(ELEMENT) + SEG_TERM;
}

/** Strip the decimal point from an ICD-10 code (X12 carries codes undelimited). */
function icd(code: string): string {
  return code.replace('.', '');
}

/**
 * Generate the full X12 interchange (ISA…IEA) containing one 837P transaction.
 */
export function generateEdi837P(input: Edi837Input): string {
  const { interchange: ic, claim } = input;
  const pos = claim.placeOfService ?? '11';
  const usage = ic.usageIndicator ?? 'P';

  // --- ISA (fixed-width) ----------------------------------------------------
  const isa = [
    'ISA',
    '00',
    fixed('', 10),
    '00',
    fixed('', 10),
    'ZZ',
    fixed(ic.senderId, 15),
    'ZZ',
    fixed(ic.receiverId, 15),
    ic.date,
    ic.time,
    '^',
    '00501',
    fixed(ic.controlNumber, 9),
    '0',
    usage,
    SUBELEMENT,
  ].join(ELEMENT) + SEG_TERM;

  const gs = seg(
    'GS',
    'HC',
    ic.senderId,
    ic.receiverId,
    ic.fullDate,
    ic.time,
    input.groupControlNumber,
    'X',
    '005010X222A1',
  );

  // --- Transaction body (ST … last segment before SE) ----------------------
  const body: string[] = [];
  const st = input.transactionControlNumber;
  body.push(seg('ST', '837', st, '005010X222A1'));
  body.push(seg('BHT', '0019', '00', claim.id, ic.fullDate, ic.time, 'CH'));

  // 1000A submitter / 1000B receiver
  body.push(seg('NM1', '41', '2', input.submitter.name, '', '', '', '', '46', input.submitter.id));
  body.push(seg('NM1', '40', '2', input.receiver.name, '', '', '', '', '46', input.receiver.id));

  // 2000A billing provider hierarchical level
  body.push(seg('HL', '1', '', '20', '1'));
  const bp = input.billingProvider;
  body.push(seg('NM1', '85', '2', bp.name, '', '', '', '', 'XX', bp.npi));
  body.push(seg('N3', bp.address.street));
  body.push(seg('N4', bp.address.city, bp.address.state, bp.address.zip));
  body.push(seg('REF', 'EI', bp.taxId));

  // 2000B subscriber hierarchical level
  body.push(seg('HL', '2', '1', '22', '0'));
  body.push(seg('SBR', 'P', '18', '', '', '', '', '', '', 'CI'));
  const sub = input.subscriber;
  body.push(seg('NM1', 'IL', '1', sub.lastName, sub.firstName, '', '', '', 'MI', sub.memberId));
  body.push(seg('NM1', 'PR', '2', input.payer.name, '', '', '', '', 'PI', input.payer.id));

  // 2300 claim
  body.push(
    seg(
      'CLM',
      claim.id,
      money(claim.totalChargeCents),
      '',
      '',
      [pos, 'B', '1'].join(SUBELEMENT),
      'Y',
      'A',
      'Y',
      'Y',
    ),
  );

  // HI diagnoses: principal ABK, subsequent ABF
  const hiElements = claim.diagnoses.map((d, i) =>
    [i === 0 ? 'ABK' : 'ABF', icd(d.code)].join(SUBELEMENT),
  );
  if (hiElements.length > 0) {
    body.push(seg('HI', ...hiElements));
  }

  // 2400 service lines
  claim.serviceLines.forEach((line, idx) => {
    body.push(seg('LX', idx + 1));
    const svcComposite = ['HC', line.cpt, ...(line.modifiers ?? [])].join(SUBELEMENT);
    const pointers = (line.diagnosisPointers ?? [1]).join(SUBELEMENT);
    body.push(
      seg('SV1', svcComposite, money(line.chargeCents), 'UN', line.units, '', '', pointers),
    );
    body.push(seg('DTP', '472', 'D8', line.dateOfService));
  });

  // --- SE / GE / IEA --------------------------------------------------------
  const segmentCount = body.length + 1; // include the SE segment itself
  const se = seg('SE', segmentCount, st);
  const ge = seg('GE', '1', input.groupControlNumber);
  const iea = seg('IEA', '1', ic.controlNumber);

  return [isa, gs, ...body, se, ge, iea].join('');
}

/** Split an interchange string back into segments (helper for tests/inspection). */
export function splitSegments(edi: string): string[] {
  return edi.split(SEG_TERM).filter((s) => s.length > 0);
}
