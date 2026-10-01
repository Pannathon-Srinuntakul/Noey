import type { Metadata } from "next";
import { notFound } from "next/navigation";
import type { ReactNode } from "react";
import { FaqList } from "@/components/FaqList";
import { FitLists } from "@/components/FitLists";
import { Breadcrumb } from "@/components/Breadcrumb";
import { ClipCard } from "@/components/ds/ClipCard";
import { CtaBand } from "@/components/ds/CtaBand";
import { IconArrowRight } from "@/components/ds/icons";
import { SectionHeader } from "@/components/ds/SectionHeader";
import { SpliceDivider } from "@/components/ds/SpliceDivider";
import { StatusCard } from "@/components/ds/StatusCard";
import { TimelineToc } from "@/components/ds/TimelineToc";
import { Waveform } from "@/components/ds/Waveform";
import { EditorMockup } from "@/components/mockups/EditorMockup";
import { MicroDemo } from "@/components/mockups/MicroDemos";
import { StepMockup } from "@/components/mockups/StepMockup";
import { AppScreen } from "@/components/mockups/app/AppScreen";
import { EditorScreen } from "@/components/mockups/app/Editor";
import { ProjectDetail } from "@/components/mockups/app/Pages";
import { ShotSwap } from "@/components/mockups/app/ShotSwap";
import { sceneStillTime } from "@/components/mockups/sample";
import { AccountPanelSkeleton } from "@/components/account/AccountSkeleton";
import { ArticleSkeletonBody } from "@/components/shell/ArticleSkeleton";
import { EditorOpenPanel } from "@/components/shell/EditorOpening";
import { RenderLoading } from "@/components/shell/RenderLoading";
import { StatusCardSkeleton } from "@/components/shell/StatusSkeleton";
import { PendingButton } from "@/components/ui/PendingButton";
import { HOME_FAQ } from "@/lib/faq";
import { HOME_FITS, HOME_MISFITS } from "@/lib/scope";
import "../../styles/parts/loading-core.css";
import "../../styles/parts/loading-deferred.css";
import "../../styles/pages/account.css";
import "../../styles/pages/article.css";
import "./kitchen-sink.css";

/**
 * Every shared component in both themes, side by side — a working sheet for
 * the redesign. Not part of the site: it 404s in production builds unless
 * NOEY_KITCHEN_SINK=1 was set at build time, and it is never indexed.
 */
export const metadata: Metadata = {
  title: { absolute: "Kitchen sink | Noey Studio" },
  robots: { index: false, follow: false },
};

function Both({ title, children, still = false }: { title: string; children: ReactNode; still?: boolean }) {
  return (
    <section className="ks-row">
      <h2 className="ks-row__title">{title}</h2>
      <div className="ks-row__panes">
        <div className={still ? "ks-pane theme-day motion-still" : "ks-pane theme-day"}>{children}</div>
        <div className={still ? "ks-pane theme-night motion-still" : "ks-pane theme-night"}>{children}</div>
      </div>
    </section>
  );
}

/** Every loading state at rest and in motion (LOADING_PROMPT.md). `still`: as reduced motion draws it. */
function LoadingRows({ still = false }: { still?: boolean }) {
  const tag = still ? " · reduced motion (still)" : "";
  return (
    <>
      <Both title={`Loading · centre piece (full, chip, emblem)${tag}`} still={still}>
        <div className="ks-loading">
          <RenderLoading />
          <RenderLoading variant="chip" />
          <RenderLoading variant="emblem" />
        </div>
      </Both>
      <Both title={`Loading · status card skeleton${tag}`} still={still}>
        <StatusCardSkeleton task="ยืนยันอีเมล" />
      </Both>
      <Both title={`Loading · account panel skeleton${tag}`} still={still}>
        <AccountPanelSkeleton demo />
      </Both>
      <Both title={`Loading · article skeleton${tag}`} still={still}>
        <div className="article-page ks-article">
          <ArticleSkeletonBody demo />
        </div>
      </Both>
      <Both title={`Loading · pending buttons and links, กำลังเปิดห้องตัดต่อ${tag}`} still={still}>
        <div className="cta-row">
          <PendingButton className="btn btn-primary" busy disabled busyLabel="กำลังเข้าสู่ระบบ…">
            เข้าสู่ระบบ
          </PendingButton>
          <PendingButton className="btn btn-secondary" busy disabled busyLabel="กำลังดำเนินการ…">
            ใช้แพลนนี้ต่อ
          </PendingButton>
          <PendingButton className="btn btn-danger" busy disabled busyLabel="กำลังลบบัญชี…">
            ลบบัญชีถาวร
          </PendingButton>
          <a className="ks-pend-link" href="#" aria-busy="true">
            ราคา
            <span className="pend" data-on="" aria-hidden="true">
              <i />
            </span>
          </a>
        </div>
        <div className="ks-edopen">
          <EditorOpenPanel demo />
        </div>
      </Both>
    </>
  );
}

export default function KitchenSinkPage() {
  if (process.env.NODE_ENV === "production" && process.env.NOEY_KITCHEN_SINK !== "1") notFound();
  const swatches = ["--bg", "--surface", "--panel", "--panel-2", "--well", "--ink", "--ink-2", "--ink-3", "--line", "--line-2", "--gold", "--gold-ink", "--gold-soft", "--danger", "--success"];

  return (
    <main id="main" className="page-top ks">
      <div className="wrap">
        <h1 className="h-1">Kitchen sink</h1>
        <p className="lede">ทุกชิ้นส่วนของ design system ในธีมสว่างและมืด</p>
      </div>

      <div className="wrap ks-rows">
        <Both title="Tokens">
          <div className="ks-swatches">
            {swatches.map((name) => (
              <span key={name} className="ks-swatch" style={{ background: `var(${name})` }}>
                <code>{name}</code>
              </span>
            ))}
          </div>
        </Both>

        <Both title="Type">
          <p className="h-display">ถ่ายเสร็จ ลากคลิป</p>
          <p className="h-1">หัวข้อระดับหนึ่ง</p>
          <p className="h-2">
            หัวข้อระดับสอง <span className="h-soft">ส่วนที่เบากว่า</span>
          </p>
          <p className="h-3">หัวข้อระดับสาม</p>
          <p className="lede">ย่อหน้านำ ระบบถอดเสียงในคลิปออกมาเป็นข้อความ เลือกช่วงที่พูดได้ดี ต่อกันเป็นคลิปเดียว</p>
          <p>เนื้อความปกติ บรรทัดสูงพอสำหรับวรรณยุกต์ที่ซ้อนบน เช่น ที่ นี่ ปั้น เปลี่ยน</p>
          <p className="meta">ข้อความรอง อัปเดตล่าสุด 29 กันยายน 2569</p>
          <p className="tc">00:01:24:12 · V1 · 1080 × 1920</p>
        </Both>

        <Both title="Buttons">
          <div className="cta-row">
            <button className="btn btn-primary btn-lg" type="button" data-magnetic="">
              เริ่มใช้ฟรี
            </button>
            <button className="btn btn-secondary btn-lg" type="button">
              ดูราคา
            </button>
            <button className="btn btn-ghost" type="button">
              เข้าสู่ระบบ
            </button>
            <button className="btn btn-danger" type="button">
              ลบบัญชี…
            </button>
            <button className="btn btn-primary" type="button" disabled>
              ปิดอยู่
            </button>
            <a className="more-link" href="#">
              อ่านขอบเขตแบบละเอียด <IconArrowRight />
            </a>
          </div>
        </Both>

        <Both title="Fields, tags, notices">
          <div className="stack" style={{ maxWidth: 420 }}>
            <div className="field">
              <label htmlFor="ks-email">อีเมล</label>
              <input id="ks-email" className="input" placeholder="you@email.com" />
            </div>
            <div className="field">
              <label htmlFor="ks-bad">รหัสผ่าน</label>
              <input id="ks-bad" className="input" aria-invalid="true" defaultValue="1234" type="password" />
              <p className="field-error">รหัสผ่านต้องมีอย่างน้อย 8 ตัวอักษร</p>
            </div>
            <label className="agree">
              <input type="checkbox" className="agree__box" defaultChecked />
              <span className="agree__text">ฉันได้อ่านและยอมรับเงื่อนไขการใช้งาน</span>
            </label>
            <div className="cta-row">
              <span className="tag tag-accent">เบต้า</span>
              <span className="tag tag-neutral">ตัวอย่างการแสดงผล</span>
              <span className="tag tag-outline">แนะนำ</span>
              <span className="mock-tag">ภาพจำลอง</span>
              <span className="stamp">อัปเดตล่าสุด 29 กันยายน 2569</span>
            </div>
            <div className="notice">
              <p>ยกเลิกการชำระเงินแล้ว ยังไม่มีการเรียกเก็บเงิน</p>
            </div>
            <div className="notice notice--warn">
              <p>ระบบบัญชีขัดข้องชั่วคราว</p>
            </div>
          </div>
        </Both>

        <Both title="Section header · splice divider">
          <SectionHeader track="V2" timecode="00:01:24:00" eyebrow="ความสามารถหลัก" title={"สามอย่างที่ทำให้\nงานเสร็จเร็วขึ้นจริง"} soft={[1]}>
            <p>ความสามารถหลักมีสามอย่าง คือตัดคลิปอัตโนมัติจากสิ่งที่พูดจริง</p>
          </SectionHeader>
          <SpliceDivider label="00:02:10:00" />
          <Breadcrumb
            trail={[
              { name: "หน้าแรก", path: "/" },
              { name: "ราคา", path: "/pricing" },
            ]}
          />
        </Both>

        <Both title="Clip cards · waveform · micro-demos">
          <div className="ks-grid">
            <ClipCard title="ซับไทยอัตโนมัติ" track="T1" timecode="00:00:04" media={<MicroDemo kind="subs" />}>
              <p>ซับขึ้นตามเสียงพูดจริง เลือกฟอนต์ ขนาด และตำแหน่งได้</p>
            </ClipCard>
            <ClipCard title="ใส่เพลงประกอบ" track="A2" timecode="00:00:09" media={<MicroDemo kind="music" />}>
              <p>เลือกท่อนที่จะใช้ ปรับระดับเสียง และถอดออกได้ทุกเมื่อ</p>
            </ClipCard>
            <ClipCard title="ไทม์ไลน์แก้มือ" track="V1" timecode="00:00:13" media={<MicroDemo kind="trim" />}>
              <p>ย้าย ยืดหด ลบ ทำซ้ำ พร้อมย้อนกลับได้ทุกขั้น</p>
            </ClipCard>
            <ClipCard title="สลับช็อตในฉากเดิม" track="V1" media={<MicroDemo kind="swap" />}>
              <p>ไม่ชอบภาพไหน เปลี่ยนเป็นเทกอื่นได้โดยจังหวะไม่เสีย</p>
            </ClipCard>
            <ClipCard title="รับไฟล์จากมือถือและกล้อง" track="IN" media={<MicroDemo kind="convert" />}>
              <p>ฟอร์แมตที่เบราว์เซอร์เปิดไม่ได้ ระบบแปลงให้ก่อนเริ่มงาน</p>
            </ClipCard>
            <ClipCard title="ได้ไฟล์พร้อมลง" track="OUT" media={<MicroDemo kind="frame" />} href="/pricing">
              <p>วิดีโอแนวตั้ง 1080×1920 ดาวน์โหลดแล้วลง TikTok, Reels หรือ Shorts ได้เลย</p>
            </ClipCard>
          </div>
          <div style={{ height: 40, marginTop: 20 }} data-play="">
            <Waveform bars={120} seed={4} cut={[[30, 44]]} />
          </div>
        </Both>

        <Both title="Lanes (fit / misfit)">
          <FitLists fits={HOME_FITS} misfits={HOME_MISFITS} fitTitle="เหมาะกับงานแบบนี้" misfitTitle="ยังทำให้ไม่ได้" headingLevel="h3" />
        </Both>

        <Both title="FAQ">
          <FaqList items={HOME_FAQ.slice(0, 3)} />
        </Both>

        <Both title="Status cards">
          <div className="ks-grid ks-grid--2">
            <StatusCard tone="success" eyebrow="ยืนยันอีเมล" title="ยืนยันอีเมลเรียบร้อย" titleAs="h2" actions={<a className="btn btn-primary" href="#">เปิดห้องตัดต่อ</a>}>
              <p>อีเมล noey@x.test ยืนยันแล้ว เริ่มใช้งาน AI ในห้องตัดต่อได้เลย</p>
            </StatusCard>
            <StatusCard tone="danger" eyebrow="ยืนยันอีเมล" title="ลิงก์หมดอายุหรือถูกใช้ไปแล้ว" titleAs="h2">
              <p>เข้าสู่ระบบ แล้วขอลิงก์ยืนยันใหม่ได้จากหน้าบัญชีของคุณ</p>
            </StatusCard>
            <StatusCard tone="pending" eyebrow="การชำระเงิน" title="กำลังยืนยันการชำระเงิน…" titleAs="h2" busy>
              <p>ใช้เวลาไม่กี่วินาที ไม่ต้องปิดหน้านี้และไม่ต้องกดจ่ายซ้ำ</p>
            </StatusCard>
            <StatusCard tone="info" eyebrow="บัญชีของฉัน" title="ลบบัญชีเรียบร้อยแล้ว" titleAs="h2">
              <p>บัญชีและโปรเจกต์บนเซิร์ฟเวอร์ถูกลบแล้ว</p>
            </StatusCard>
          </div>
        </Both>

        <LoadingRows />
        <LoadingRows still />

        <Both title="Timeline TOC">
          <div style={{ maxWidth: 320 }}>
            <TimelineToc
              label="หัวข้อในหน้านี้"
              items={[
                { id: "a", label: "สามขั้นตอนตั้งแต่ไฟล์ดิบจนได้คลิปพร้อมลง" },
                { id: "b", label: "เลือกโหมดไหนให้ตรงกับคลิปที่ถ่ายมา" },
                { id: "c", label: "AI ตัดจากอะไร ไม่ใช่สุ่มตัดตามเวลา" },
              ]}
            />
          </div>
        </Both>

        <Both title="Editor mockup">
          <div style={{ maxWidth: 760, paddingTop: 20 }}>
            <EditorMockup />
          </div>
        </Both>

        <Both title="App screens (ปรับช็อต · ส่งออกวิดีโอ)">
          <div className="ks-grid">
            <AppScreen width={1024} height={768}>
              <ShotSwap behind={<EditorScreen windowWidth={1024} time={sceneStillTime(2)} />} />
            </AppScreen>
            <AppScreen width={1024} height={768}>
              <ProjectDetail exportOpen />
            </AppScreen>
          </div>
        </Both>

        <Both title="Step mockups">
          <div className="ks-grid">
            <StepMockup kind="import" label="ลากไฟล์เข้าโปรเจกต์" />
            <StepMockup kind="style" label="เลือกโหมดและความยาว" />
            <StepMockup kind="timeline" label="หน้าพรีวิวและไทม์ไลน์" />
          </div>
        </Both>
      </div>

      <CtaBand id="ks-cta" title="ลองตัดคลิปแรกวันนี้" actions={<a className="btn btn-primary btn-lg" href="#">สมัครใช้งาน</a>}>
        <p>สมัครแล้วได้เครดิตทดลองฟรีทันที ไม่ต้องผูกบัตร ใช้หมดแล้วค่อยเลือกแพลนรายเดือน</p>
      </CtaBand>
    </main>
  );
}
