/**
 * Text drawn into each route's generated Open Graph image. Kept apart from the
 * page copy because satori cannot draw every Thai syllable (see thai-text.ts):
 * the headlines below were chosen to avoid a tone mark stacked on an upper
 * vowel, and `og-copy.test.ts` fails if an edit reintroduces one.
 */
export interface OgCopy {
  eyebrow: string;
  title: string;
  subtitle: string;
  /** og:image:alt */
  alt: string;
}

export const OG_COPY = {
  home: {
    eyebrow: "ตัดคลิป TikTok ด้วย AI",
    title: "ถ่ายเสร็จ ลากคลิปเข้าเว็บ ให้ AI ตัดร่างแรกให้ก่อน",
    subtitle: "ถอดเสียงไทย เลือกช่วงไฮไลต์ ใส่ซับ แล้วแก้ต่อในไทม์ไลน์ได้ทุกช็อต",
    alt: "Noey Studio ตัดคลิป TikTok ด้วย AI ในเบราว์เซอร์",
  },
  pricing: {
    eyebrow: "ราคา",
    title: "เลือกแพลนตามปริมาณงาน",
    subtitle: "ใช้ฟรีได้ ไม่ต้องผูกบัตร แล้วค่อยขยับตามปริมาณงาน",
    alt: "ราคาและแพลนของ Noey Studio",
  },
  scope: {
    eyebrow: "ทำอะไรได้บ้าง",
    title: "ระบบคัดช็อตให้ แล้วคุณเกลาต่อ",
    subtitle: "ถอดเสียง คัดช็อต เรียงลำดับ และใส่ซับไทยเป็นร่างแรก",
    alt: "Noey Studio ทำอะไรได้บ้าง และอะไรที่ยังทำไม่ได้",
  },
  about: {
    eyebrow: "คุยกับเราได้",
    title: "ติดต่อทีมงาน Noey Studio",
    subtitle: "ห้องตัดต่อวิดีโอด้วย AI ในเบราว์เซอร์ สำหรับคนถ่ายคลิปเอง",
    alt: "เกี่ยวกับ Noey Studio และช่องทางติดต่อ",
  },
  signup: {
    eyebrow: "สมัครใช้งาน",
    title: "สมัครใช้งานฟรี ไม่ต้องผูกบัตร",
    subtitle: "ใช้ได้ทุกโหมด รวมโหมดพากย์ใหม่",
    alt: "สมัครใช้งาน Noey Studio ฟรี",
  },
} satisfies Record<string, OgCopy>;
