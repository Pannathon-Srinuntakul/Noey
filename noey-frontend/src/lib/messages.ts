/** User-facing Thai messages shared by forms and actions. Calm, specific, no blame. */
export const MSG = {
  generic: "ระบบขัดข้องชั่วคราว ลองใหม่อีกครั้งในอีกสักครู่",
  /** Any 429 from the backend (per-IP / per-account rate limits). */
  rateLimited: "ส่งถี่เกินไป ลองใหม่อีกครั้งภายหลัง",
  billingUnavailable:
    "ระบบชำระเงินยังไม่เปิดใช้งานในตอนนี้ ใช้แพลนฟรีต่อได้ตามปกติ ถ้าอยากอัปเกรดก่อน ติดต่อทีมงานได้ที่หน้าเกี่ยวกับเรา",
  registrationClosed:
    "ขณะนี้ยังไม่เปิดรับสมัครสมาชิกใหม่ ฝากข้อความถึงทีมงานไว้ที่หน้าเกี่ยวกับเราได้ แล้วเราจะแจ้งกลับเมื่อเปิดรับสมัคร",
  alreadyOnPlan: "คุณใช้แพลนนี้อยู่แล้ว เลือกแพลนอื่น หรือจัดการแพลนได้ที่หน้าแพลนและการชำระเงิน",
  resumeInstead: "แพลนนี้ตั้งให้สิ้นสุดเมื่อจบรอบบิลอยู่ ถ้าอยากใช้ต่อ กด “ใช้แพลนนี้ต่อ” ที่หน้าแพลนและการชำระเงิน",
  /** Both billing endpoints answered 409 (e.g. a plan change already scheduled, or an admin-managed plan). */
  planChangeBlocked:
    "เปลี่ยนแพลนจากหน้านี้ไม่ได้ในตอนนี้ อาจมีการเปลี่ยนแพลนที่รอมีผลเมื่อจบรอบบิลอยู่แล้ว ถ้าต้องการความช่วยเหลือ ติดต่อทีมงานได้ที่หน้าเกี่ยวกับเรา",
  noBillingCustomer: "ยังไม่มีข้อมูลการชำระเงินในระบบ จะดูใบเสร็จและจัดการบัตรได้หลังสมัครแพลนแรก",
  /** 503 from an endpoint that sends email (SendGrid not configured on the backend). */
  emailUnavailable: "ระบบส่งอีเมลยังไม่พร้อมใช้งานในตอนนี้ ลองใหม่อีกครั้งภายหลัง",
  captchaFailed: "ยืนยันว่าไม่ใช่บอทไม่สำเร็จ ลองติ๊กยืนยันอีกครั้งแล้วส่งใหม่",
  passwordRule: "รหัสผ่านต้องมีอย่างน้อย 8 ตัวอักษร",
  passwordTooLong: "รหัสผ่านยาวเกินไป ใช้ได้ไม่เกิน 72 ไบต์ (ตัวอักษรไทยหนึ่งตัวนับ 3 ไบต์ ภาษาไทยล้วนได้ราว 24 ตัว)",
  linkExpired: "ลิงก์หมดอายุหรือถูกใช้ไปแล้ว",
  forgotSent: "ถ้ามีบัญชีที่ใช้อีเมลนี้ เราส่งลิงก์ตั้งรหัสผ่านใหม่ให้แล้ว",
} as const;

export interface ActionState {
  ok?: boolean;
  error?: string;
  success?: string;
  fieldErrors?: Record<string, string>;
  /** Non-secret values echoed back so a failed submit keeps what was typed. */
  values?: Record<string, string>;
  /** Error that should offer a fresh link (expired reset/verify tokens). */
  expired?: boolean;
}
