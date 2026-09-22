import type { Metadata } from "next";
import { Breadcrumb } from "@/components/Breadcrumb";
import { JsonLd } from "@/components/JsonLd";
import { FaqList } from "@/components/FaqList";
import { ContactForm } from "@/components/forms/ContactForm";
import { ABOUT_FAQ } from "@/lib/faq";
import Link from "next/link";
import { formatThaiDate } from "@/lib/format";
import { breadcrumbNode, faqPageNode, jsonLdGraph, organizationNode, webPageNode } from "@/lib/jsonld";
import { pageMetadata } from "@/lib/seo";
import { CONTACT_EMAIL } from "@/lib/server/config";
import { PAGES } from "@/lib/site";

export const metadata: Metadata = pageMetadata("about");

const TRAIL = [
  { name: PAGES.home.label, path: PAGES.home.path },
  { name: PAGES.about.label, path: PAGES.about.path },
];

export default function AboutPage() {
  const page = PAGES.about;
  const jsonLd = jsonLdGraph(
    webPageNode({ path: page.path, name: page.title, description: page.description, dateModified: page.updated, type: "AboutPage" }),
    breadcrumbNode(TRAIL),
    organizationNode({ email: CONTACT_EMAIL }),
    faqPageNode(ABOUT_FAQ, page.path),
  );

  return (
    <main id="main" className="container page">
      <div className="about-grid">
        <div>
          <Breadcrumb trail={TRAIL} />
          <h1 className="about-title">เครื่องมือที่เราทำขึ้นเพราะเราต้องใช้เอง</h1>
          <div className="about-body">
            <p>
              Noey Studio เริ่มจากงานประจำวันของครีเอเตอร์คนหนึ่งที่ลงคลิปรีวิวสินค้าทุกวัน ถ่ายไม่ใช่ปัญหา
              แต่การนั่งตัดคลิปวันละหลายชั่วโมงคือสิ่งที่ทำให้จำนวนคลิปต่อสัปดาห์ไปต่อไม่ได้
            </p>
            <p>
              เราจึงเขียนระบบที่ทำงานซ้ำ ๆ ตรงนั้นแทน เริ่มจากการถอดเสียงและเลือกช่วงที่พูดได้ดี แล้วค่อยขยายเป็นการพากย์ ซับ
              และการจัดไทม์ไลน์ จนกลายเป็นห้องตัดต่อที่เปิดในเบราว์เซอร์ได้ทั้งชุด
            </p>
            <p>หลักที่เรายึดคือ AI ควรทำร่างแรกให้เร็ว แต่คนต้องแก้ทับได้ทุกจุด ไม่ใช่กดปุ่มเดียวแล้วรับผลที่แก้อะไรไม่ได้</p>
            <p>
              หลักเดียวกันนี้ใช้กับสิ่งที่เขียนบนเว็บด้วย เราเขียนเฉพาะสิ่งที่ระบบทำได้จริงในวันนี้ และบอกข้อจำกัดไว้ตรง ๆ
              ตัวเลขที่ยังไม่ได้วัดด้วยวิธีที่บอกได้ว่าวัดอย่างไร เราจะไม่ประกาศ อ่านขอบเขตทั้งหมดได้ใน
              {" "}
              <Link href={PAGES.scope.path}>หน้าทำอะไรได้บ้าง</Link> และวิธีใช้งานทีละงานใน
              {" "}
              <Link href={PAGES.guide.path}>คู่มือใช้งาน</Link>
            </p>
            <p>
              เครื่องมือนี้ถูกใช้กับงานจริงทุกวันก่อนจะเปิดให้คนอื่นใช้ สิ่งที่อยู่ในระบบวันนี้จึงมาจากปัญหาที่เจอเองซ้ำ ๆ เช่น
              การไล่ฟุตเทจหลายไฟล์เพื่อหาเทกที่ใช้ได้ การพิมพ์ซับทีละบรรทัด และการอัดเสียงพากย์ใหม่เฉพาะประโยคที่พูดพลาด
              ฟีเจอร์ที่ไม่ได้แก้ปัญหาซ้ำแบบนั้น เราเลือกที่จะยังไม่ทำ
            </p>
            <p>
              วันนี้ระบบใช้งานได้จริงกับคลิปสั้นภาษาไทยสามแบบ คือคลิปพูดหน้ากล้องที่อยากตัดช่วงเงียบออก คลิปขายของที่ถ่ายไว้หลายมุม
              และคลิปยาวที่อยากแยกเป็นคลิปสั้นหลายตัว ทั้งสามแบบจบในเบราว์เซอร์เดียวโดยไม่ต้องสลับไปโปรแกรมอื่นกลางทาง
            </p>
            <p>
              ระบบทำงานในเบราว์เซอร์บนคอมพิวเตอร์ ใช้ Chrome หรือ Edge เวอร์ชันใหม่ รับไฟล์ MP4 และ MOV แล้วส่งออกเป็นวิดีโอ
              แนวตั้ง 1080×1920 มีทั้งแพลนฟรีที่ไม่ต้องผูกบัตร และแพลนรายเดือนสำหรับคนที่ลงคลิปถี่ขึ้น รายละเอียดทั้งหมดอยู่ใน
              {" "}
              <Link href={PAGES.pricing.path}>หน้าราคา</Link> และ
              {" "}
              <Link href={PAGES.guideHelp.path}>หน้าช่วยเหลือ</Link>
            </p>
            <p>
              ถ้าติดปัญหาหรืออยากให้ระบบทำอะไรเพิ่ม ส่งข้อความหาเราได้จากแบบฟอร์มข้าง ๆ บอกชื่อโปรเจกต์ โหมดที่ใช้ และสิ่งที่เกิดขึ้น
              จะช่วยให้ตรวจสอบได้เร็วขึ้นมาก คำถามที่ถูกถามซ้ำหลายครั้งมักจบลงในหน้าคู่มือหรือหน้าช่วยเหลือ เพื่อให้คนถัดไปหาคำตอบได้เองโดยไม่ต้องรอ
            </p>
            <p className="updated">
              อัปเดตล่าสุด <time dateTime={page.updated}>{formatThaiDate(page.updated)}</time>
            </p>
          </div>
        </div>

        <section id="contact" className="card contact-card" aria-labelledby="contact-title">
          <div className="card-kicker">ติดต่อ</div>
          <h2 id="contact-title">คุยกับเราได้</h2>
          {/* The backend sends the email; if it cannot (503) the form offers this mailto address instead. */}
          <ContactForm contactEmail={CONTACT_EMAIL} />
        </section>
      </div>

      <section style={{ marginTop: 56, maxWidth: 760 }} aria-labelledby="about-principles-title">
        <h2 id="about-principles-title" className="subsection-title" style={{ marginBottom: 18 }}>
          หลักที่เรายึดตอนทำระบบ
        </h2>
        <ul className="ruled-list ruled-list--loose">
          <li>
            <strong>AI ทำร่างแรก คนตัดสินใจ</strong>
            <br />
            ระบบคัดช็อต เรียงลำดับ และใส่ซับให้เร็วที่สุดเท่าที่ทำได้ แต่ทุกอย่างต้องแก้ทับได้ในไทม์ไลน์ ไม่มีผลลัพธ์ไหนที่ล็อกไว้จนแก้ไม่ได้
          </li>
          <li>
            <strong>การเกลาต้องไม่มีค่าใช้จ่าย</strong>
            <br />
            การแก้ไทม์ไลน์ การสลับช็อต และการเรนเดอร์ซ้ำ ไม่กินโควตา เพราะถ้าคิดเงินตอนเกลา คนจะไม่กล้าเกลา ซึ่งขัดกับเหตุผลที่ใช้เครื่องมือนี้
          </li>
          <li>
            <strong>เขียนเฉพาะสิ่งที่ทำได้จริงวันนี้</strong>
            <br />
            ข้อจำกัดถูกเขียนไว้ในหน้าเว็บพอ ๆ กับความสามารถ และเราไม่ประกาศตัวเลขที่ยังไม่ได้วัดด้วยวิธีที่บอกได้ว่าวัดอย่างไร
          </li>
          <li>
            <strong>ข้อจำกัดต้องรู้ก่อนเริ่ม ไม่ใช่รู้ตอนจ่ายเงินแล้ว</strong>
            <br />
            เพดานฟุตเทจต่อโปรเจกต์ จำนวนงานที่ทำพร้อมกันได้ และพื้นที่เก็บงานของทุกแพลน เขียนไว้ครบในหน้าราคาและหน้าช่วยเหลือ
            ระบบยังตรวจความยาวฟุตเทจให้ตั้งแต่ตอนลากไฟล์เข้ามา เพื่อให้รู้ผลก่อนเริ่มงาน ไม่ใช่ตอนที่ตัดไปครึ่งทางแล้ว
          </li>
          <li>
            <strong>ไฟล์และงานเป็นของผู้ใช้</strong>
            <br />
            ดาวน์โหลดไฟล์ที่เรนเดอร์แล้วได้ตลอด และรายละเอียดเรื่องข้อมูลกับสิทธิในผลงานอยู่ในหน้าความเป็นส่วนตัวและเงื่อนไขการใช้งาน
          </li>
        </ul>
      </section>

      <section style={{ marginTop: 56, maxWidth: 760 }} aria-labelledby="about-faq-title">
        <h2 id="about-faq-title" className="subsection-title" style={{ marginBottom: 18 }}>
          คำถามที่พบบ่อยเกี่ยวกับเรา (FAQ)
        </h2>
        <FaqList items={ABOUT_FAQ} compact />
      </section>

      <JsonLd data={jsonLd} />
    </main>
  );
}
