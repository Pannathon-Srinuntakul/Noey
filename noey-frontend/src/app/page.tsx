import type { Metadata } from "next";
import Link from "next/link";
import { FaqList } from "@/components/FaqList";
import { JsonLd } from "@/components/JsonLd";
import { FitLists } from "@/components/FitLists";
import { MediaSlot } from "@/components/MediaSlot";
import { PriceCards } from "@/components/PriceCards";
import { HOME_FAQ } from "@/lib/faq";
import { formatThaiDate } from "@/lib/format";
import { HOME_FITS, HOME_MISFITS } from "@/lib/scope";
import {
  SOFTWARE_ID,
  faqPageNode,
  howToNode,
  jsonLdGraph,
  organizationNode,
  softwareApplicationNode,
  webPageNode,
  websiteNode,
} from "@/lib/jsonld";
import { MEDIA } from "@/lib/media";
import { pageMetadata } from "@/lib/seo";
import { getPriceTable } from "@/lib/server/prices";
import { PAGES } from "@/lib/site";

// Static, re-generated at most every 10 minutes so prices follow the backend.
export const revalidate = 600;

export const metadata: Metadata = pageMetadata("home", {
  ogTitle: "Noey Studio — ตัดคลิป TikTok ด้วย AI ในเบราว์เซอร์",
  ogDescription: "ลากคลิปเข้าเว็บ ให้ AI ตัดร่างแรกให้ก่อน ถอดเสียงไทย เลือกช่วงไฮไลต์ ใส่ซับ แล้วแก้ต่อในไทม์ไลน์ได้ทุกช็อต",
  twitterDescription: "ลากคลิปเข้าเว็บ ให้ AI ตัดร่างแรกให้ก่อน แล้วแก้ต่อในไทม์ไลน์ได้ทุกช็อต",
});

const FEATURES = [
  {
    title: "AI ตัดคลิปให้อัตโนมัติ",
    body: "เลือกได้ว่าจะเก็บทุกฉากตามลำดับเดิม เก็บเฉพาะช่วงไฮไลต์ที่พูดได้ดี หรือเรียงภาพใหม่ตามสคริปต์พากย์ ระบบวางคัตให้ลงตรงจังหวะที่ประโยคจบ",
  },
  {
    title: "พากย์เสียง พร้อมสคริปต์จาก AI",
    body: "ระบบเขียนสคริปต์พากย์ภาษาไทยให้ตามภาพที่มี แบ่งเป็นประโยคสั้น ๆ ให้อ่านทีละบรรทัด อัดเสียงในเบราว์เซอร์ อัดใหม่เฉพาะประโยคที่ไม่พอใจได้ แล้วระบบวางเสียงให้ตรงช็อต",
  },
  {
    title: "เปิดเบราว์เซอร์ก็ใช้ได้",
    body: "ไม่มีโปรแกรมให้ติดตั้งและไม่ต้องตั้งค่าอะไรก่อนเริ่ม เข้าเว็บ ล็อกอิน แล้วลากคลิปเข้ามา โปรเจกต์ผูกกับบัญชี จะกลับมาทำต่อจากคอมเครื่องอื่นก็ได้",
  },
];

const MINI_CARDS = [
  { title: "ซับไทยอัตโนมัติ", body: "ซับขึ้นตามเสียงพูดจริง เลือกฟอนต์ ขนาด และตำแหน่งได้" },
  { title: "ใส่เพลงประกอบ", body: "เลือกท่อนที่จะใช้ ปรับระดับเสียง และถอดออกได้ทุกเมื่อ" },
  { title: "ไทม์ไลน์แก้มือ", body: "ย้าย ยืดหด ลบ ทำซ้ำ พร้อมย้อนกลับได้ทุกขั้น" },
  { title: "สลับช็อตในฉากเดิม", body: "ไม่ชอบภาพไหน เปลี่ยนเป็นเทกอื่นได้โดยจังหวะไม่เสีย" },
  { title: "รับไฟล์จากมือถือและกล้อง", body: "ฟอร์แมตที่เบราว์เซอร์เปิดไม่ได้ ระบบแปลงให้ก่อนเริ่มงาน" },
  { title: "ได้ไฟล์พร้อมลง", body: "วิดีโอแนวตั้ง 1080×1920 ดาวน์โหลดแล้วลง TikTok, Reels หรือ Shorts ได้เลย" },
];

const STEPS = [
  {
    media: MEDIA.stepImport,
    title: "ลากฟุตเทจเข้ามา",
    body: "ลากคลิปจากมือถือหรือกล้องเข้ามาได้หลายไฟล์พร้อมกัน ระบบตรวจความยาวและความละเอียดให้ ไฟล์ฟอร์แมตแปลกก็แปลงให้ก่อน",
  },
  {
    media: MEDIA.stepStyle,
    title: "บอกว่าอยากได้คลิปแบบไหน",
    // "สไตล์การตัด" dropped from the design's copy: styles are hidden on the web
    // editor (owner, 2026-09-22), so the site must not promise them.
    body: "เลือกโหมด ความยาวที่ต้องการ และจะใช้เสียงในคลิปเดิมหรือพากย์ใหม่ จากนั้นกดปุ่มเดียวแล้วรอผล",
  },
  {
    media: MEDIA.stepTimeline,
    title: "ดู แก้ แล้วดาวน์โหลด",
    body: "ดูคลิปที่ได้ ปรับตรงไหนก็แก้ในไทม์ไลน์แล้วเรนเดอร์ใหม่ พอพอใจก็ดาวน์โหลดไฟล์ไปลงได้เลย",
  },
];

export default async function HomePage() {
  const table = await getPriceTable();
  const home = PAGES.home;
  const jsonLd = jsonLdGraph(
    organizationNode(),
    websiteNode(),
    softwareApplicationNode(table),
    webPageNode({ path: home.path, name: home.title, description: home.description, dateModified: home.updated, about: SOFTWARE_ID }),
    faqPageNode(HOME_FAQ, home.path),
    // The three visible steps below, nothing invented: no time estimate is
    // claimed because none has been measured.
    howToNode({
      path: home.path,
      name: "วิธีตัดคลิปสั้นด้วย AI ใน Noey Studio",
      description: "สามขั้นตอนจากฟุตเทจดิบจนได้ไฟล์วิดีโอแนวตั้ง 1080×1920 พร้อมลง TikTok, Reels หรือ Shorts",
      steps: STEPS.map((step) => ({ name: step.title, text: step.body })),
    }),
  );

  return (
    <main id="main">
      <section className="container hero" aria-labelledby="hero-title">
        <p className="eyebrow">สำหรับครีเอเตอร์และแม่ค้าที่ถ่ายคลิปเอง</p>
        <h1 id="hero-title" className="display-title hero__title">
          ถ่ายเสร็จ ลากคลิปเข้าเว็บ
          <br />
          ให้ AI ตัดร่างแรกให้ก่อน
        </h1>
        <div className="hero__rule" aria-hidden="true" />
        {/* Answer-first block: what the product is and does, in one extractable paragraph. */}
        <p className="hero__lead">
          Noey Studio เป็นห้องตัดต่อที่เปิดในเบราว์เซอร์ ระบบถอดเสียงในคลิปออกมาเป็นข้อความ เลือกช่วงที่พูดได้ดี ต่อกันเป็นคลิปเดียว
          เขียนสคริปต์พากย์ให้ และใส่ซับไทยให้ จากนั้นคุณดูผล แก้ตรงไหนก็ได้ในไทม์ไลน์ แล้วดาวน์โหลดไปลง
        </p>
        <div className="cta-row">
          <Link href="/signup" className="btn btn-primary btn-lg">
            เริ่มใช้ฟรี
          </Link>
        </div>
        <p className="fine">มีแพลนฟรีให้ใช้ต่อเนื่อง · ไม่ต้องผูกบัตร · ใช้บนคอมผ่าน Chrome หรือ Edge</p>
        <p className="fine hero__honest">ระบบทำร่างแรกให้ ไม่ได้ตัดจบแทนคุณ งานที่เหลือยังแก้เองในไทม์ไลน์</p>
        <p className="updated">
          อัปเดตล่าสุด <time dateTime={home.updated}>{formatThaiDate(home.updated)}</time>
        </p>
      </section>

      <section className="usp" aria-labelledby="usp-title">
        <h2 id="usp-title" className="sr-only">
          จุดเด่นของ Noey Studio
        </h2>
        <ul className="container usp__grid">
          <li className="usp__item">
            <h3>ไม่ต้องติดตั้งโปรแกรม</h3>
            <p>เปิดเบราว์เซอร์บนคอมแล้วเริ่มงานได้เลย</p>
          </li>
          <li className="usp__item">
            <h3>ตัดจากสิ่งที่คุณพูดจริง</h3>
            <p>ระบบถอดเสียงก่อน แล้วเลือกช่วงจากเนื้อหา ไม่ใช่สุ่มตัด</p>
          </li>
          <li className="usp__item">
            <h3>แก้ทับได้ทุกช็อต</h3>
            <p>ไทม์ไลน์เปิดให้แก้เองเสมอ ไม่ใช่กดปุ่มเดียวแล้วจบ</p>
          </li>
        </ul>
      </section>

      <section className="container section-pad problem" aria-labelledby="problem-title">
        <h2 id="problem-title" className="section-title">
          งานที่กินเวลาที่สุด
          <br />
          ไม่ใช่การถ่าย แต่เป็นการตัด
        </h2>
        <div className="problem__body">
          <p>
            ครีเอเตอร์ส่วนใหญ่ถ่ายคลิปหนึ่งตัวจบภายในไม่กี่นาที แต่ใช้เวลาอีกหลายเท่าไปกับการไล่ดูฟุตเทจ หาช่วงที่พูดรู้เรื่อง
            ตัดช่วงที่พูดผิดออก พิมพ์ซับ แล้วจัดจังหวะใหม่อีกรอบ ยิ่งลงคลิปถี่ เวลาส่วนนี้ยิ่งกลืนทั้งวัน
          </p>
          <p>
            Noey Studio ทำขั้นตอนที่ซ้ำ ๆ ตรงนั้นแทน ระบบถอดเสียงทั้งคลิปเป็นข้อความก่อน แล้วให้ AI อ่านสิ่งที่คุณพูดจริง ๆ
            เพื่อเลือกช่วงที่ควรเก็บและลำดับที่ควรวาง สิ่งที่ได้กลับมาคือคลิปที่ตัดแล้วหนึ่งตัว ไม่ใช่รายการงานที่ต้องทำต่อ
          </p>
          <p>ร่างแรกไม่ต้องสมบูรณ์ก็ได้ เพราะไทม์ไลน์ยังอยู่ครบ ย้าย ยืดหด ลบ หรือสลับช็อตในฉากเดิม แล้วเรนเดอร์ใหม่ได้ไม่จำกัดครั้ง</p>
        </div>
      </section>

      <section id="features" className="section" aria-labelledby="features-title">
        <div className="container section-pad">
          <div className="features__intro">
            <p className="eyebrow">ความสามารถหลัก</p>
            <h2 id="features-title" className="section-title">
              สามอย่างที่ทำให้งานเสร็จเร็วขึ้นจริง
            </h2>
            <p className="pricing-intro">
              ความสามารถหลักมีสามอย่าง คือตัดคลิปอัตโนมัติจากสิ่งที่พูดจริง เขียนสคริปต์พากย์ภาษาไทยพร้อมให้อัดเสียงในเบราว์เซอร์
              และใส่ซับไทยตามเสียงพูด ทั้งสามอย่างทำงานในเบราว์เซอร์โดยไม่ต้องติดตั้งโปรแกรม
            </p>
          </div>
          <div className="features__grid">
            {FEATURES.map((feature, index) => (
              <article key={feature.title} className="feature">
                <div className="num feature__num" aria-hidden="true">
                  {String(index + 1).padStart(2, "0")}
                </div>
                <h3>{feature.title}</h3>
                <p>{feature.body}</p>
              </article>
            ))}
          </div>
          <div className="mini-cards">
            {MINI_CARDS.map((card) => (
              <div key={card.title} className="card">
                <div className="card-title">{card.title}</div>
                <p className="card-body">{card.body}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      <section id="how" className="section section-muted" aria-labelledby="how-title">
        <div className="container section-pad">
          <div className="features__intro">
            <p className="eyebrow">วิธีใช้งาน</p>
            <h2 id="how-title" className="section-title">
              สามขั้นตอน จบในหน้าเดียว
            </h2>
            <p className="pricing-intro">
              ขั้นตอนใช้งานมีสามขั้น คือลากฟุตเทจเข้ามา เลือกโหมดและความยาวที่ต้องการ แล้วดูผล เกลาในไทม์ไลน์ และดาวน์โหลดไฟล์
              วิดีโอแนวตั้ง 1080×1920 การแก้และเรนเดอร์ซ้ำทำได้ไม่จำกัดครั้งโดยไม่กินโควตา
            </p>
          </div>
          <ol className="steps">
            {STEPS.map((step, index) => (
              <li key={step.title} className="step">
                <div className="step__media">
                  <MediaSlot media={step.media} sizes="(max-width: 800px) 90vw, 360px" />
                </div>
                <h3>
                  <span className="num step__n">{index + 1}. </span>
                  {step.title}
                </h3>
                <p>{step.body}</p>
              </li>
            ))}
          </ol>
        </div>
      </section>

      <section className="section" aria-labelledby="scope-title">
        <div className="container section-pad">
          <p className="eyebrow">ขอบเขตของระบบ</p>
          <h2 id="scope-title" className="section-title scope-teaser__title">
            ระบบคัดช็อตให้ ไม่ได้ตัดจบแทนคุณ
          </h2>
          <p className="scope-teaser__lead">
            สิ่งที่ได้กลับมาคือร่างแรก — ช็อตที่คัดมาแล้ว เรียงลำดับไว้ พร้อมซับไทย จากนั้นยังต้องเข้าไปเกลาจังหวะและลำดับเองในไทม์ไลน์เกือบทุกครั้ง
            ส่วนที่ประหยัดคือเวลานั่งไล่ฟุตเทจทีละช่วงและพิมพ์ซับเอง ไม่ใช่การตัดต่อทั้งกระบวนการ
          </p>
          <FitLists fits={HOME_FITS} misfits={HOME_MISFITS} fitTitle="เหมาะกับงานแบบนี้" misfitTitle="ยังทำให้ไม่ได้" headingLevel="h3" />
          <p className="scope-teaser__more">
            <Link href={PAGES.scope.path}>อ่านขอบเขตแบบละเอียด ทำอะไรได้ ทำอะไรไม่ได้</Link>
          </p>
        </div>
      </section>

      <section className="section section-muted" aria-labelledby="pricing-title">
        <div className="container section-pad">
          <p className="eyebrow">ราคา</p>
          <h2 id="pricing-title" className="section-title" style={{ marginBottom: 12 }}>
            เริ่มฟรี แล้วค่อยขยับตามปริมาณงาน
          </h2>
          <p className="pricing-intro" style={{ marginBottom: 40 }}>
            ทุกแพลนได้ไทม์ไลน์ ซับไทย และการเรนเดอร์แบบไม่จำกัดครั้ง ที่ต่างกันคือปริมาณงาน AI ต่อรอบ ความยาวคลิปต่อโปรเจกต์ และพื้นที่เก็บงาน
          </p>
          <PriceCards table={table} variant="home" />
          <p style={{ margin: "26px 0 0" }}>
            <Link href="/pricing" style={{ fontSize: 15 }}>
              ดูทั้ง 7 แพลน รวม Lite, Agency และ Max
            </Link>
          </p>
        </div>
      </section>

      <section className="section" aria-labelledby="faq-title">
        <div className="container-narrow section-pad">
          <h2 id="faq-title" className="section-title" style={{ marginBottom: 36 }}>
            คำถามที่พบบ่อย (FAQ)
          </h2>
          <FaqList items={HOME_FAQ} />
          <p className="scope-teaser__more">
            <Link href={PAGES.guide.path}>อ่านคู่มือใช้งานแบบละเอียด ทั้งการตัดคลิป ซับไทย และหน้าช่วยเหลือ</Link>
          </p>
        </div>
      </section>

      <section className="section" aria-labelledby="cta-title">
        <div className="container-narrow final-cta">
          <h2 id="cta-title">ลองตัดคลิปแรกวันนี้</h2>
          <p>สมัครแล้วเริ่มที่แพลนฟรีได้ทันที ไม่ต้องผูกบัตร อยากได้โควตามากขึ้นค่อยอัปเกรดทีหลัง</p>
          <Link href="/signup" className="btn btn-primary" style={{ fontSize: 15, padding: "12px 26px" }}>
            สมัครใช้งาน
          </Link>
        </div>
      </section>

      <JsonLd data={jsonLd} />
    </main>
  );
}
