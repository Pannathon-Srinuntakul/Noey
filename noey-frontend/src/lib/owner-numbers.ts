/**
 * Numbers only the owner can supply, in ONE place.
 *
 * Nothing here may be guessed. Every value starts as `null`, and every
 * component that reads one renders NOTHING while it is null — never a
 * placeholder, never a rounded guess, never "up to X". A measured number on a
 * marketing page is a claim; an invented one is a lie an answer engine will
 * repeat for us.
 *
 * To fill one in: measure it, write the value AND the `measured` date, then
 * bump the `updated` date of every page that shows it in `site.ts`.
 */

export interface OwnerNumber {
  /** The value to show, e.g. "3 นาที". `null` = not measured yet, render nothing. */
  value: string | null;
  /** ISO date the number was measured. Shown next to the value. */
  measured: string | null;
  /** What exactly was measured — becomes the sentence around the value. */
  note: string;
}

export type OwnerNumberKey =
  | "renderTimeFiveMinuteClip"
  | "draftTimeFiveMinuteClip"
  | "transcriptionAccuracyThai"
  | "creatorsUsing";

export const OWNER_NUMBERS: Record<OwnerNumberKey, OwnerNumber> = {
  renderTimeFiveMinuteClip: {
    value: null,
    measured: null,
    note: "เวลาเรนเดอร์คลิปยาว 1 นาที จากฟุตเทจดิบ 5 นาที บนเครื่องมาตรฐานที่ระบุไว้",
  },
  draftTimeFiveMinuteClip: {
    value: null,
    measured: null,
    note: "เวลาตั้งแต่กดเริ่มจนได้ร่างแรก จากฟุตเทจดิบ 5 นาที",
  },
  transcriptionAccuracyThai: {
    value: null,
    measured: null,
    note: "ความแม่นของการถอดเสียงไทย วัดจากชุดคลิปทดสอบที่ประกาศวิธีวัดไว้",
  },
  creatorsUsing: {
    value: null,
    measured: null,
    note: "จำนวนผู้ใช้งานจริง นับจากบัญชีที่เรนเดอร์อย่างน้อยหนึ่งคลิป",
  },
};

/** The value, or null when it has not been measured yet (render nothing). */
export function ownerNumber(key: OwnerNumberKey): string | null {
  const entry = OWNER_NUMBERS[key];
  return entry.value && entry.measured ? entry.value : null;
}
