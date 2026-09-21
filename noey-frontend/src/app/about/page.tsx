import type { Metadata } from "next";
import { Breadcrumb } from "@/components/Breadcrumb";
import { JsonLd } from "@/components/JsonLd";
import { ContactForm } from "@/components/forms/ContactForm";
import { breadcrumbNode, jsonLdGraph, organizationNode, webPageNode } from "@/lib/jsonld";
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
          </div>
        </div>

        <section id="contact" className="card contact-card" aria-labelledby="contact-title">
          <div className="card-kicker">ติดต่อ</div>
          <h2 id="contact-title">คุยกับเราได้</h2>
          {/* The backend sends the email; if it cannot (503) the form offers this mailto address instead. */}
          <ContactForm contactEmail={CONTACT_EMAIL} />
        </section>
      </div>

      <JsonLd data={jsonLd} />
    </main>
  );
}
