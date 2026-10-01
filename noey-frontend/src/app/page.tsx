import type { Metadata } from "next";
import { ModeTracks } from "@/components/home/ModeTracks";
import Link from "next/link";
import type { CSSProperties } from "react";
import { BetaPriceNote } from "@/components/BetaPriceNote";
import { ComputerOnly } from "@/components/ComputerOnly";
import { FaqList } from "@/components/FaqList";
import { JsonLd } from "@/components/JsonLd";
import { FitLists } from "@/components/FitLists";
import { MediaSlot } from "@/components/MediaSlot";
import { PriceCards } from "@/components/PriceCards";
import { ClipCard } from "@/components/ds/ClipCard";
import { CtaBand } from "@/components/ds/CtaBand";
import { IconArrowRight } from "@/components/ds/icons";
import { SectionHeader } from "@/components/ds/SectionHeader";
import { WordReveal } from "@/components/ds/WordReveal";
import { HeroBackdrop } from "@/components/hero/HeroBackdrop";
import { EditorMockup, FeatureVisual, MicroDemo } from "@/components/mockups/client";
import { HERO_BEAT_MS } from "@/components/mockups/EditorMockup";
import type { MicroKind } from "@/components/mockups/MicroDemos";
import { HOME_FAQ } from "@/lib/faq";
import { formatThaiDate } from "@/lib/format";
import { HOME_FITS, HOME_MISFITS, SCOPE_STEPS } from "@/lib/scope";
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
import "../styles/pages/home.css";
import { keepThaiProse } from "@/components/ds/ThaiProse";

// Static, re-generated at most every 10 minutes so prices follow the backend.
export const revalidate = 600;

export const metadata: Metadata = pageMetadata("home", {
  ogTitle: "Noey Studio — ตัดคลิป TikTok ด้วย AI ในเบราว์เซอร์",
  ogDescription: "ลากคลิปเข้าเว็บ ให้ AI ตัดดราฟต์แรกให้ก่อน ถอดเสียงไทย เลือกช่วงไฮไลต์ ใส่ซับ แล้วแก้ต่อในไทม์ไลน์ได้ทุกช็อต",
  twitterDescription: "ลากคลิปเข้าเว็บ ให้ AI ตัดดราฟต์แรกให้ก่อน แล้วแก้ต่อในไทม์ไลน์ได้ทุกช็อต",
});

const FEATURES = [
  {
    title: "AI ตัดคลิปให้อัตโนมัติ",
    body: "เลือกได้ว่าจะเก็บทุกฉากตามลำดับเดิม เก็บเฉพาะช่วงไฮไลต์ที่พูดได้ดี หรือเรียงภาพใหม่ตามสคริปต์พากย์ ระบบวางคัตให้ลงตรงจังหวะที่ประโยคจบ",
  },
  {
    title: "พากย์เสียง พร้อมสคริปต์จาก AI",
    body: "ระบบเขียนสคริปต์พากย์ภาษาไทยให้ตามภาพที่ตัดไว้ แบ่งเป็นประโยคสั้น ๆ ตามช็อต ได้คลิปภาพพร้อมสคริปต์ กดคัดลอกไปอัดเสียงเองได้ทันที",
  },
  {
    title: "เปิดเบราว์เซอร์ก็ใช้ได้",
    body: "ไม่มีโปรแกรมให้ติดตั้งและไม่ต้องตั้งค่าอะไรก่อนเริ่ม เข้าเว็บ ล็อกอิน แล้วลากคลิปเข้ามา โปรเจกต์ผูกกับบัญชี จะกลับมาทำต่อจากคอมเครื่องอื่นก็ได้",
  },
];

// Each clip's label names the job its demo shows, the way an editor tags a
// clip — not a track number: V1–V3 on this page are the three tracks above.
const MINI_CARDS: ReadonlyArray<{ title: string; body: string; demo: MicroKind; track: string }> = [
  { title: "ซับไทยอัตโนมัติ", body: "ซับขึ้นตามเสียงพูดจริง เลือกฟอนต์ ขนาด และตำแหน่งได้", demo: "subs", track: "SUB" },
  { title: "ใส่เพลงประกอบ", body: "เลือกท่อนที่จะใช้ ปรับระดับเสียง และถอดออกได้ทุกเมื่อ", demo: "music", track: "BGM" },
  { title: "ไทม์ไลน์แก้มือ", body: "ย้าย ยืดหด ลบ ทำซ้ำ พร้อมย้อนกลับได้ทุกขั้น", demo: "trim", track: "TRIM" },
  { title: "สลับช็อตในฉากเดิม", body: "ไม่ชอบภาพไหน เปลี่ยนเป็นเทกอื่นได้โดยจังหวะไม่เสีย", demo: "swap", track: "SWAP" },
  { title: "รับไฟล์จากมือถือและกล้อง", body: "ฟอร์แมตที่เบราว์เซอร์เปิดไม่ได้ ระบบแปลงให้ก่อนเริ่มงาน", demo: "convert", track: "IN" },
  { title: "ได้ไฟล์พร้อมลง", body: "วิดีโอแนวตั้ง 1080×1920 ดาวน์โหลดแล้วลง TikTok, Reels หรือ Shorts ได้เลย", demo: "frame", track: "OUT" },
];

/** The hero's fine print; its last part says again what the computer-only note says on a phone. */
const HERO_FINE = "สมัครแล้วได้เครดิตทดลองฟรี · ไม่ต้องผูกบัตร · ใช้ได้เฉพาะบนคอมผ่าน Chrome หรือ Edge";
const HERO_FINE_CUT = HERO_FINE.lastIndexOf(" · ");

/**
 * A "read more" link whose arrow stays with its last word when the text
 * wraps (on a phone the arrow would otherwise start a line of its own).
 */
function MoreLink({ href, children }: { href: string; children: string }) {
  const cut = children.lastIndexOf(" ");
  return (
    <Link href={href} className="more-link">
      {children.slice(0, cut + 1)}
      <span className="more-link__end">
        {children.slice(cut + 1)}
        <IconArrowRight size={18} />
      </span>
    </Link>
  );
}

const STEPS = [
  {
    media: MEDIA.stepImport,
    title: "ลากฟุตเทจเข้ามา",
    body: "ลากคลิปจากมือถือหรือกล้องเข้ามาได้หลายไฟล์พร้อมกัน ระบบตรวจความยาวและความละเอียดให้",
  },
  {
    media: MEDIA.stepStyle,
    title: "บอกว่าอยากได้คลิปแบบไหน",
    // "สไตล์การตัด" dropped from the design's copy: styles are hidden on the web
    // editor (owner, 2026-09-22), so the site must not promise them.
    body: "เลือกหนึ่งในสามโหมดให้ตรงกับคลิป แล้วตั้งค่าของโหมดนั้น จากนั้นกดปุ่มเดียวแล้วรอผล",
  },
  {
    media: MEDIA.stepTimeline,
    title: "ดู แก้ แล้วดาวน์โหลด",
    body: "ดูคลิปที่ได้ ปรับตรงไหนก็แก้ในไทม์ไลน์แล้วเรนเดอร์ใหม่ พอพอใจก็ดาวน์โหลดไฟล์ไปลงได้เลย",
  },
];

/**
 * The four beats of the hero scene, beside the app's own screens in the order
 * a user meets them: files in, the outcome chosen and started, the system
 * cutting, the result in the editor. Copy that already describes each step
 * elsewhere on the site (the steps below, lib/scope.ts).
 */
const BEATS = [
  { title: STEPS[0].title, body: STEPS[0].body },
  { title: STEPS[1].title, body: STEPS[1].body },
  SCOPE_STEPS[1],
  SCOPE_STEPS[2],
];

/**
 * Without JavaScript the hero is not pinned and its illustration shows the
 * finished draft (the editor) instead of waiting for scroll-driven beats.
 */
const NO_SCRIPT_HERO = `
.hero-scene{height:auto!important}
.hero-scene__sticky{position:relative!important;height:auto!important;min-height:0!important}
.ed-scene .edm__beat{opacity:0!important;visibility:hidden!important}
.ed-scene .edm__beat--3{opacity:1!important;visibility:visible!important;scale:1!important}
.beats li{opacity:1!important}
`;

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
    <main id="main" className="home">
      <noscript>
        <style>{NO_SCRIPT_HERO}</style>
      </noscript>

      {/* ── 1. Hero: the copy is there at first paint; the scene below it is pinned on desktop ── */}
      <section className="hero" aria-labelledby="hero-title">
        <HeroBackdrop />
        <div className="wrap hero__intro page-top">
          <div className="hero__eyebrow">
            <span className="trk tc" aria-hidden="true">
              REC
            </span>
            <p>{keepThaiProse("สำหรับครีเอเตอร์และแม่ค้าที่ถ่ายคลิปเอง")}</p>
          </div>
          <WordReveal as="h1" id="hero-title" text={"ถ่ายเสร็จ ลากคลิปเข้าเว็บ\nให้ AI ตัดดราฟต์แรกให้ก่อน"} className="h-display hero__title" soft={[1]} />
          <div className="hero__cols">
            {/* Answer-first block: what the product is and does, in one extractable paragraph. */}
            <p className="hero__lead">
              {keepThaiProse("Noey Studio เป็นห้องตัดต่อที่เปิดในเบราว์เซอร์ ระบบถอดเสียงในคลิปออกมาเป็นข้อความ เลือกช่วงที่พูดได้ดี ต่อกันเป็นคลิปเดียว เขียนสคริปต์พากย์ให้ และใส่ซับไทยให้ จากนั้นคุณดูผล แก้ตรงไหนก็ได้ในไทม์ไลน์ แล้วดาวน์โหลดไปลง")}
            </p>
            <div className="hero__act">
              <div className="cta-row">
                <Link href="/signup" className="btn btn-primary btn-lg" data-magnetic="">
                  เริ่มใช้ฟรี
                  <IconArrowRight size={18} />
                </Link>
              </div>
              <ComputerOnly />
              <p className="hero__fine">
                {keepThaiProse(HERO_FINE.slice(0, HERO_FINE_CUT))}
                {/* Where the computer-only note shows (phones), it already said this. */}
                <span className="hero__fine-desk">{keepThaiProse(HERO_FINE.slice(HERO_FINE_CUT))}</span>
              </p>
              <p className="hero__fine hero__honest">{keepThaiProse("ระบบทำดราฟต์แรกให้ ไม่ได้ตัดจบแทนคุณ งานที่เหลือยังแก้เองในไทม์ไลน์")}</p>
              <p className="stamp">
                อัปเดตล่าสุด <time dateTime={home.updated}>{formatThaiDate(home.updated)}</time>
              </p>
            </div>
          </div>
        </div>

        <div className="hero-scene ed-scene" data-scene="4" data-scene-auto="" data-scene-durations={HERO_BEAT_MS.join(",")} data-beat="0">
          <div className="hero-scene__sticky">
            <div className="wrap hero-scene__grid">
              <ol className="beats">
                {BEATS.map((beat, index) => (
                  <li key={beat.title} className="beats__item" style={{ "--b": index } as CSSProperties}>
                    <span className="beats__n tc" aria-hidden="true">
                      {String(index + 1).padStart(2, "0")}
                    </span>
                    <span className="beats__text">
                      <strong className="beats__title">{keepThaiProse(beat.title)}</strong>
                      <span className="beats__body">{keepThaiProse(beat.body)}</span>
                    </span>
                  </li>
                ))}
              </ol>
              <div className="hero-scene__stage" data-scene-stage="">
                <EditorMockup />
              </div>
            </div>
            <div className="hero-scene__rail" aria-hidden="true">
              <span className="hero-scene__rail-fill" />
            </div>
          </div>
        </div>
      </section>

      {/* ── 2. Three points as three parallel tracks ── */}
      <section className="usp" aria-labelledby="usp-title">
        <h2 id="usp-title" className="sr-only">
          จุดเด่นของ Noey Studio
        </h2>
        <div className="wrap">
          <div className="usp__ruler" aria-hidden="true">
            {["00:00:00:00", "00:00:04:00", "00:00:08:00", "00:00:12:00"].map((mark) => (
              <span key={mark} className="tc">
                {mark}
              </span>
            ))}
          </div>
          <div className="usp__stage" data-reveal="usp">
            <ul className="usp__tracks">
              {[
                { track: "V1", title: "ไม่ต้องติดตั้งโปรแกรม", body: "เปิดเบราว์เซอร์บนคอมแล้วเริ่มงานได้เลย" },
                { track: "V2", title: "ตัดจากสิ่งที่คุณพูดจริง", body: "ระบบถอดเสียงก่อน แล้วเลือกช่วงจากเนื้อหา ไม่ใช่สุ่มตัด" },
                { track: "V3", title: "แก้ทับได้ทุกช็อต", body: "ไทม์ไลน์เปิดให้แก้เองเสมอ ไม่ใช่กดปุ่มเดียวแล้วจบ" },
              ].map((item, index) => (
                <li key={item.title} className="usp__track" style={{ "--t": index } as CSSProperties}>
                  <span className="trk tc" aria-hidden="true">
                    {item.track}
                  </span>
                  <div className="usp__clip">
                    <h3>{keepThaiProse(item.title)}</h3>
                    <p>{keepThaiProse(item.body)}</p>
                  </div>
                </li>
              ))}
            </ul>
            <span className="usp__playhead" aria-hidden="true" />
          </div>
        </div>
      </section>

      {/* ── 3. The problem: sticky heading, paragraphs arriving, a clock that keeps running ── */}
      <section className="sect problem" aria-labelledby="problem-title">
        <div className="wrap problem__grid">
          <div className="problem__head">
            <SectionHeader id="problem-title" marker timecode="00:00:18:00" title={"งานที่กินเวลาที่สุด\nไม่ใช่การถ่าย แต่เป็นการตัด"} soft={[1]} />
            <div className="problem__clock" data-play="" aria-hidden="true">
              <span className="problem__clock-dot" />
              <span className="problem__clock-tc" />
            </div>
          </div>
          <div className="problem__body">
            <p data-reveal="rise">
              {keepThaiProse("ครีเอเตอร์ส่วนใหญ่ถ่ายคลิปหนึ่งตัวจบภายในไม่กี่นาที แต่ใช้เวลาอีกหลายเท่าไปกับการไล่ดูฟุตเทจ หาช่วงที่พูดรู้เรื่อง ตัดช่วงเงียบออก พิมพ์ซับ แล้วจัดจังหวะใหม่อีกรอบ ยิ่งลงคลิปถี่ เวลาส่วนนี้ยิ่งกลืนทั้งวัน")}
            </p>
            <p data-reveal="rise">
              {keepThaiProse("Noey Studio ทำขั้นตอนที่ซ้ำ ๆ ตรงนั้นแทน ระบบถอดเสียงทั้งคลิปเป็นข้อความก่อน แล้วให้ AI อ่านสิ่งที่คุณพูดจริง ๆ เพื่อเลือกช่วงที่ควรเก็บและลำดับที่ควรวาง สิ่งที่ได้กลับมาคือคลิปที่ตัดแล้วหนึ่งตัว ไม่ใช่รายการงานที่ต้องทำต่อ")}
            </p>
            <p data-reveal="rise" className="problem__last">
              {keepThaiProse("ดราฟต์แรกไม่ต้องสมบูรณ์ก็ได้ เพราะไทม์ไลน์ยังอยู่ครบ ย้าย ยืดหด ลบ หรือสลับช็อตในฉากเดิม แล้วเรนเดอร์ใหม่ได้ไม่จำกัดครั้ง")}
            </p>
          </div>
        </div>
      </section>

      {/* ── 4. Features: a bento of the three big ones, then six clips with their own demos ── */}
      <section id="features" className="sect features" aria-labelledby="features-title">
        <div className="wrap">
          <SectionHeader id="features-title" marker timecode="00:00:42:10" title="สามอย่างที่ทำให้งานเสร็จเร็วขึ้นจริง">
            <p>
              {keepThaiProse("ความสามารถหลักมีสามอย่าง คือตัดคลิปอัตโนมัติจากสิ่งที่พูดจริง เขียนสคริปต์พากย์ภาษาไทยให้เอาไปอัดเสียงได้ทันที และใส่ซับไทยตามเสียงพูด ทั้งสามอย่างทำงานในเบราว์เซอร์โดยไม่ต้องติดตั้งโปรแกรม")}
            </p>
          </SectionHeader>
          <div className="bento" data-reveal="stagger">
            {FEATURES.map((feature, index) => (
              <article key={feature.title} className={`bento__card bento__card--${index + 1}`}>
                <div className="bento__visual" data-play="">
                  <FeatureVisual index={index} />
                  <span className="mock-tag bento__tag">ภาพจำลอง</span>
                </div>
                <div className="bento__text">
                  <div className="num bento__num" aria-hidden="true">
                    {String(index + 1).padStart(2, "0")}
                  </div>
                  <h3>{keepThaiProse(feature.title)}</h3>
                  <p>{keepThaiProse(feature.body)}</p>
                </div>
              </article>
            ))}
          </div>
          {/* One label for the six small demos: each is an illustration too. */}
          <p className="minis__tag">
            <span className="mock-tag">ภาพจำลอง</span>
          </p>
          <div className="minis" data-reveal="stagger">
            {MINI_CARDS.map((card, index) => (
              <ClipCard
                key={card.title}
                title={card.title}
                track={card.track}
                timecode={`00:00:${String(4 + index * 5).padStart(2, "0")}`}
                media={<MicroDemo kind={card.demo} />}
                className="mini"
              >
                <p>{keepThaiProse(card.body)}</p>
              </ClipCard>
            ))}
          </div>
        </div>
      </section>

      {/* ── 5. How it works: three steps, scrubbed sideways on desktop ── */}
      <section id="how" className="how" aria-labelledby="how-title">
        <div className="how-scene" data-scene="3">
          <div className="how-scene__sticky">
            <div className="how__viewport">
              <div className="how__track" data-scene-track="">
                <div className="how__intro">
                  <SectionHeader id="how-title" marker timecode="00:01:08:00" title="สามขั้นตอน จบในหน้าเดียว">
                    <p>
                      {keepThaiProse("ขั้นตอนใช้งานมีสามขั้น คือลากฟุตเทจเข้ามา เลือกโหมดที่ตรงกับคลิป แล้วดูผล เกลาในไทม์ไลน์ และดาวน์โหลดไฟล์ วิดีโอแนวตั้ง 1080×1920 การแก้และเรนเดอร์ซ้ำทำได้ไม่จำกัดครั้งโดยไม่กินโควตา")}
                    </p>
                  </SectionHeader>
                </div>
                <ol className="how__steps">
                  {STEPS.map((step, index) => (
                    <li key={step.title} className="how__step" style={{ "--s": index } as CSSProperties}>
                      <div className="how__media">
                        <MediaSlot media={step.media} sizes="(max-width: 800px) 90vw, 520px" />
                      </div>
                      <div className="how__text">
                        <span className="how__n num" aria-hidden="true">
                          {String(index + 1).padStart(2, "0")}
                        </span>
                        <div>
                          <h3>
                            <span className="num step__n">{index + 1}. </span>
                            {keepThaiProse(step.title)}
                          </h3>
                          <p>{keepThaiProse(step.body)}</p>
                        </div>
                      </div>
                    </li>
                  ))}
                </ol>
              </div>
            </div>
            <div className="how__progress" aria-hidden="true">
              <span />
            </div>
          </div>
        </div>
      </section>

      {/* ── 5b. The three modes: what each is for, how it works, what comes out ── */}
      <section id="modes" className="sect modes-sect" aria-labelledby="modes-title">
        <div className="wrap">
          <SectionHeader id="modes-title" marker timecode="00:01:22:00" title="สามโหมด สำหรับคลิปสามแบบ">
            <p>
              {keepThaiProse("โหมดคือสิ่งที่กำหนดว่า AI ตัดจากอะไร เลือกให้ตรงกับคลิปที่ถ่ายมา แล้วระบบทำส่วนที่เหลือ ทุกโหมดใช้ได้ทุกแพลน รวมแพลนฟรี")}
            </p>
          </SectionHeader>
          <ModeTracks />
        </div>
      </section>

      {/* ── 6. Scope: what fits and what does not, side by side at equal weight ── */}
      <section className="sect scope-teaser" aria-labelledby="scope-title">
        <div className="wrap">
          <SectionHeader id="scope-title" marker timecode="00:01:36:12" title="ระบบคัดช็อตให้ ไม่ได้ตัดจบแทนคุณ">
            <p>
              {keepThaiProse("สิ่งที่ได้กลับมาคือดราฟต์แรก — ช็อตที่คัดมาแล้ว เรียงลำดับไว้ พร้อมซับไทย จากนั้นยังต้องเข้าไปเกลาจังหวะและลำดับเองในไทม์ไลน์เกือบทุกครั้ง ส่วนที่ประหยัดคือเวลานั่งไล่ฟุตเทจทีละช่วงและพิมพ์ซับเอง ไม่ใช่การตัดต่อทั้งกระบวนการ")}
            </p>
          </SectionHeader>
          <FitLists fits={HOME_FITS} misfits={HOME_MISFITS} fitTitle="เหมาะกับงานแบบนี้" misfitTitle="ยังทำให้ไม่ได้" headingLevel="h3" />
          <p className="section-more">
            <MoreLink href={PAGES.scope.path}>อ่านขอบเขตแบบละเอียด ทำอะไรได้ ทำอะไรไม่ได้</MoreLink>
          </p>
        </div>
      </section>

      {/* ── 7. Pricing ── */}
      <section className="sect home-pricing" aria-labelledby="pricing-title">
        <div className="wrap">
          <SectionHeader id="pricing-title" marker timecode="00:02:04:00" title="เริ่มฟรี แล้วค่อยขยับตามปริมาณงาน">
            <p>
              {keepThaiProse("ทุกแพลนได้ไทม์ไลน์ ซับไทย และการเรนเดอร์แบบไม่จำกัดครั้ง ที่ต่างกันคือจำนวนคลิปที่ AI ตัดให้ต่อเดือน ความยาวฟุตเทจต่อโปรเจกต์ และพื้นที่เก็บงาน")}
            </p>
          </SectionHeader>
          <BetaPriceNote table={table} />
          <PriceCards table={table} variant="home" />
          <p className="section-more">
            <MoreLink href="/pricing">ดูทั้ง 7 แพลน รวม Lite, Agency และ Max</MoreLink>
          </p>
        </div>
      </section>

      {/* ── 8. FAQ ── */}
      <section className="sect home-faq" aria-labelledby="faq-title">
        <div className="wrap">
          {/* A no-break space: "(FAQ)" never takes a line of its own. */}
          <SectionHeader id="faq-title" marker timecode="00:02:31:08" title={"คำถามที่พบบ่อย (FAQ)"} />
          <FaqList items={HOME_FAQ} />
          <p className="section-more">
            <MoreLink href={PAGES.guide.path}>อ่านคู่มือใช้งานแบบละเอียด ทั้งการตัดคลิป ซับไทย และหน้าช่วยเหลือ</MoreLink>
          </p>
        </div>
      </section>

      {/* ── 9. Cut to night ── */}
      <CtaBand
        id="cta-title"
        title="ลองตัดคลิปแรกวันนี้"
        actions={
          <Link href="/signup" className="btn btn-primary btn-lg" data-magnetic="">
            เริ่มใช้ฟรี
          </Link>
        }
      >
        <p>{keepThaiProse("สมัครแล้วได้เครดิตทดลองฟรีทันที ไม่ต้องผูกบัตร ใช้หมดแล้วค่อยเลือกแพลนรายเดือน")}</p>
      </CtaBand>

      <JsonLd data={jsonLd} />
    </main>
  );
}
