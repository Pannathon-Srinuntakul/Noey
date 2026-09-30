import type { Metadata } from "next";
import Link from "next/link";
import type { ReactNode } from "react";
import { Breadcrumb } from "@/components/Breadcrumb";
import { FaqList } from "@/components/FaqList";
import { JsonLd } from "@/components/JsonLd";
import { IconLock } from "@/components/ds/icons";
import { PageHero } from "@/components/ds/PageHero";
import { SectionHeader } from "@/components/ds/SectionHeader";
import { keepThai } from "@/components/ds/ThaiText";
import { formatTimecode } from "@/components/ds/timecode";
import { Waveform } from "@/components/ds/Waveform";
import { ContactForm } from "@/components/forms/ContactForm";
import { ABOUT_FAQ } from "@/lib/faq";
import { formatThaiDate } from "@/lib/format";
import { breadcrumbNode, faqPageNode, jsonLdGraph, organizationNode, webPageNode } from "@/lib/jsonld";
import { pageMetadata } from "@/lib/seo";
import { CONTACT_EMAIL } from "@/lib/server/config";
import { PAGES } from "@/lib/site";
import "../../styles/pages/about.css";

export const metadata: Metadata = pageMetadata("about");

const TRAIL = [
  { name: PAGES.home.label, path: PAGES.home.path },
  { name: PAGES.about.label, path: PAGES.about.path },
];

/**
 * The story, cut into chapters. Only the structure is new: the eight
 * paragraphs are the page's own text, two per chapter, and a chapter is
 * marked by a timecode rather than a written title.
 */
const CHAPTERS: readonly { start: number; paragraphs: readonly ReactNode[] }[] = [
  {
    start: 0,
    paragraphs: [
      keepThai(
        "Noey Studio เริ่มจากงานประจำวันของครีเอเตอร์คนหนึ่งที่ลงคลิปรีวิวสินค้าทุกวัน ถ่ายไม่ใช่ปัญหา แต่การนั่งตัดคลิปวันละหลายชั่วโมงคือสิ่งที่ทำให้จำนวนคลิปต่อสัปดาห์ไปต่อไม่ได้",
      ),
      keepThai(
        "เราจึงเขียนระบบที่ทำงานซ้ำ ๆ ตรงนั้นแทน เริ่มจากการถอดเสียงและเลือกช่วงที่พูดได้ดี แล้วค่อยขยายเป็นการพากย์ ซับ และการจัดไทม์ไลน์ จนกลายเป็นห้องตัดต่อที่เปิดในเบราว์เซอร์ได้ทั้งชุด",
      ),
    ],
  },
  {
    start: 38.4,
    paragraphs: [
      keepThai("หลักที่เรายึดคือ AI ควรทำร่างแรกให้เร็ว แต่คนต้องแก้ทับได้ทุกจุด ไม่ใช่กดปุ่มเดียวแล้วรับผลที่แก้อะไรไม่ได้"),
      <>
        {keepThai(
          "หลักเดียวกันนี้ใช้กับสิ่งที่เขียนบนเว็บด้วย เราเขียนเฉพาะสิ่งที่ระบบทำได้จริงในวันนี้ และบอกข้อจำกัดไว้ตรง ๆ ตัวเลขที่ยังไม่ได้วัดด้วยวิธีที่บอกได้ว่าวัดอย่างไร เราจะไม่ประกาศ อ่านขอบเขตทั้งหมดได้ใน",
        )}{" "}
        <Link href={PAGES.scope.path}>หน้าทำอะไรได้บ้าง</Link> และวิธีใช้งานทีละงานใน <Link href={PAGES.guide.path}>คู่มือใช้งาน</Link>
      </>,
    ],
  },
  {
    start: 71.12,
    paragraphs: [
      keepThai(
        "เครื่องมือนี้ถูกใช้กับงานจริงทุกวันก่อนจะเปิดให้คนอื่นใช้ สิ่งที่อยู่ในระบบวันนี้จึงมาจากปัญหาที่เจอเองซ้ำ ๆ เช่น การไล่ฟุตเทจหลายไฟล์เพื่อหาเทกที่ใช้ได้ การพิมพ์ซับทีละบรรทัด และการอัดเสียงพากย์ใหม่เฉพาะประโยคที่พูดพลาด ฟีเจอร์ที่ไม่ได้แก้ปัญหาซ้ำแบบนั้น เราเลือกที่จะยังไม่ทำ",
      ),
      keepThai(
        "วันนี้ระบบใช้งานได้จริงกับคลิปสั้นภาษาไทยสามแบบ คือคลิปพูดหน้ากล้องที่อยากตัดช่วงเงียบออก คลิปขายของที่ถ่ายไว้หลายมุม และคลิปยาวที่อยากแยกเป็นคลิปสั้นหลายตัว ทั้งสามแบบจบในเบราว์เซอร์เดียวโดยไม่ต้องสลับไปโปรแกรมอื่นกลางทาง",
      ),
    ],
  },
  {
    start: 112.2,
    paragraphs: [
      <>
        {keepThai(
          "ระบบทำงานในเบราว์เซอร์บนคอมพิวเตอร์ ใช้ Chrome หรือ Edge เวอร์ชันใหม่ รับไฟล์ MP4 และ MOV แล้วส่งออกเป็นวิดีโอ แนวตั้ง 1080×1920 มีทั้งแพลนฟรีที่ไม่ต้องผูกบัตร และแพลนรายเดือนสำหรับคนที่ลงคลิปถี่ขึ้น รายละเอียดทั้งหมดอยู่ใน",
        )}{" "}
        <Link href={PAGES.pricing.path}>หน้าราคา</Link> และ <Link href={PAGES.guideHelp.path}>หน้าช่วยเหลือ</Link>
      </>,
      keepThai(
        "ถ้าติดปัญหาหรืออยากให้ระบบทำอะไรเพิ่ม ส่งข้อความหาเราได้จากแบบฟอร์มข้าง ๆ บอกชื่อโปรเจกต์ โหมดที่ใช้ และสิ่งที่เกิดขึ้น จะช่วยให้ตรวจสอบได้เร็วขึ้นมาก คำถามที่ถูกถามซ้ำหลายครั้งมักจบลงในหน้าคู่มือหรือหน้าช่วยเหลือ เพื่อให้คนถัดไปหาคำตอบได้เองโดยไม่ต้องรอ",
      ),
    ],
  },
];

const PRINCIPLES = [
  {
    title: "AI ทำร่างแรก คนตัดสินใจ",
    text: "ระบบคัดช็อต เรียงลำดับ และใส่ซับให้เร็วที่สุดเท่าที่ทำได้ แต่ทุกอย่างต้องแก้ทับได้ในไทม์ไลน์ ไม่มีผลลัพธ์ไหนที่ล็อกไว้จนแก้ไม่ได้",
  },
  {
    title: "การเกลาต้องไม่มีค่าใช้จ่าย",
    text: "การแก้ไทม์ไลน์ การสลับช็อต และการเรนเดอร์ซ้ำ ไม่กินโควตา เพราะถ้าคิดเงินตอนเกลา คนจะไม่กล้าเกลา ซึ่งขัดกับเหตุผลที่ใช้เครื่องมือนี้",
  },
  {
    title: "เขียนเฉพาะสิ่งที่ทำได้จริงวันนี้",
    text: "ข้อจำกัดถูกเขียนไว้ในหน้าเว็บพอ ๆ กับความสามารถ และเราไม่ประกาศตัวเลขที่ยังไม่ได้วัดด้วยวิธีที่บอกได้ว่าวัดอย่างไร",
  },
  {
    title: "ข้อจำกัดต้องรู้ก่อนเริ่ม ไม่ใช่รู้ตอนจ่ายเงินแล้ว",
    text: "เพดานฟุตเทจต่อโปรเจกต์ จำนวนงานที่ทำพร้อมกันได้ และพื้นที่เก็บงานของทุกแพลน เขียนไว้ครบในหน้าราคาและหน้าช่วยเหลือ ระบบยังตรวจความยาวฟุตเทจให้ตั้งแต่ตอนลากไฟล์เข้ามา เพื่อให้รู้ผลก่อนเริ่มงาน ไม่ใช่ตอนที่ตัดไปครึ่งทางแล้ว",
  },
  {
    title: "ไฟล์และงานเป็นของผู้ใช้",
    text: "ดาวน์โหลดไฟล์ที่เรนเดอร์แล้วได้ตลอด และรายละเอียดเรื่องข้อมูลกับสิทธิในผลงานอยู่ในหน้าความเป็นส่วนตัวและเงื่อนไขการใช้งาน",
  },
] as const;

/**
 * /about. The story reads as a sequence of chapters on a vertical timeline
 * (a timecode per chapter, a rail that fills as you read), with the contact
 * form held beside it on desktop. The five principles are locked tracks —
 * the part of the project nobody edits.
 */
export default function AboutPage() {
  const page = PAGES.about;
  const jsonLd = jsonLdGraph(
    webPageNode({
      path: page.path,
      name: page.title,
      description: page.description,
      dateModified: page.updated,
      type: "AboutPage",
    }),
    breadcrumbNode(TRAIL),
    organizationNode({ email: CONTACT_EMAIL }),
    faqPageNode(ABOUT_FAQ, page.path),
  );

  return (
    <main id="main" className="about-page">
      <PageHero
        crumb={<Breadcrumb trail={TRAIL} />}
        title="เครื่องมือที่เราทำขึ้นเพราะเราต้องใช้เอง"
        meta={
          <p className="stamp">
            อัปเดตล่าสุด <time dateTime={page.updated}>{formatThaiDate(page.updated)}</time>
          </p>
        }
      />

      <div className="wrap about-layout">
        <div className="chapters">
          {CHAPTERS.map((chapter, index) => (
            <div key={chapter.start} className="chapter" data-reveal="rise">
              <div className="chapter__mark" aria-hidden="true">
                <span className="chapter__dot" />
                <span className="trk tc">CH{index + 1}</span>
                <span className="chapter__tc tc">{formatTimecode(chapter.start)}</span>
              </div>
              <div className={index === 0 ? "chapter__text chapter__text--open" : "chapter__text"}>
                {chapter.paragraphs.map((paragraph, at) => (
                  <p key={at}>{paragraph}</p>
                ))}
              </div>
            </div>
          ))}
        </div>

        <aside className="about-contact">
          <section id="contact" className="card contact-card" aria-labelledby="contact-title">
            <div className="contact-card__bar" aria-hidden="true">
              <span className="contact-card__rec" />
              <span className="tc">MSG</span>
              <span className="contact-card__rule" />
            </div>
            <div className="card-kicker">ติดต่อ</div>
            <h2 id="contact-title" className="contact-card__title">
              คุยกับเราได้
            </h2>
            {/* The backend sends the email; if it cannot (503) the form offers this mailto address instead. */}
            <ContactForm contactEmail={CONTACT_EMAIL} />
          </section>
        </aside>
      </div>

      <section className="sect principles" aria-labelledby="about-principles-title">
        <div className="wrap">
          <SectionHeader id="about-principles-title" track="L" timecode="00:02:40:00" title="หลักที่เรายึดตอนทำระบบ" size="h-3" />
          <ul className="locked" data-reveal="stagger">
            {PRINCIPLES.map((principle, index) => (
              <li key={principle.title} className="locked__track">
                <div className="locked__head" aria-hidden="true">
                  <span className="trk tc">L{index + 1}</span>
                  <IconLock size={16} className="locked__lock" />
                </div>
                <div className="locked__clip">
                  <div className="locked__copy">
                    <strong className="locked__title">{keepThai(principle.title)}</strong>
                    <span className="locked__text">{keepThai(principle.text)}</span>
                  </div>
                  <Waveform bars={40} seed={index * 5 + 11} className="locked__wave" still />
                </div>
              </li>
            ))}
          </ul>
        </div>
      </section>

      <section className="sect about-faq" aria-labelledby="about-faq-title">
        <div className="wrap">
          <SectionHeader id="about-faq-title" track="Q" timecode="00:03:12:00" title="คำถามที่พบบ่อยเกี่ยวกับเรา (FAQ)" size="h-3" />
          <div className="about-faq__list">
            <FaqList items={ABOUT_FAQ} compact />
          </div>
        </div>
      </section>

      <JsonLd data={jsonLd} />
    </main>
  );
}
