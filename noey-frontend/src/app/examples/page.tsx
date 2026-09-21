import type { Metadata } from "next";
import Link from "next/link";
import { Breadcrumb } from "@/components/Breadcrumb";
import { JsonLd } from "@/components/JsonLd";
import { MediaSlot } from "@/components/MediaSlot";
import { breadcrumbNode, jsonLdGraph, webPageNode } from "@/lib/jsonld";
import { MEDIA } from "@/lib/media";
import { pageMetadata } from "@/lib/seo";
import { PAGES } from "@/lib/site";

export const metadata: Metadata = pageMetadata("examples");

const TRAIL = [
  { name: PAGES.home.label, path: PAGES.home.path },
  { name: PAGES.examples.label, path: PAGES.examples.path },
];

export default function ExamplesPage() {
  const page = PAGES.examples;
  const jsonLd = jsonLdGraph(
    webPageNode({ path: page.path, name: page.title, description: page.description, dateModified: page.updated, type: "CollectionPage" }),
    breadcrumbNode(TRAIL),
  );

  return (
    <main id="main" className="container page">
      <Breadcrumb trail={TRAIL} />
      <h1 className="page-title">คลิปที่ตัดด้วย Noey Studio</h1>
      <p className="lead" style={{ margin: "0 0 48px", maxWidth: "40em" }}>
        ตัวอย่างนี้ทำด้วยโหมดพากย์ใหม่ ถ่ายภาพมาก่อนโดยไม่ต้องพูด แล้วมาอัดเสียงพากย์ตามสคริปต์ที่ AI เขียนให้ทีหลัง
      </p>

      <div className="examples-work">
        <figure>
          <MediaSlot media={MEDIA.examplesWork} />
          <figcaption>
            <strong>รีวิวสินค้า</strong>
            <br />
            <span className="num">โหมดพากย์ใหม่ · ฟุตเทจ 8 ไฟล์</span>
          </figcaption>
        </figure>
        <div className="examples-work__text">
          <h2>งานนี้ทำยังไง</h2>
          <p>
            ฟุตเทจดิบ 8 ไฟล์ ถ่ายเก็บภาพสินค้าไว้เฉย ๆ ไม่มีเสียงพูด ระบบดูภาพทั้งหมดแล้วเขียนสคริปต์พากย์ภาษาไทยให้
            แบ่งเป็นประโยคสั้น ๆ ให้อ่านทีละบรรทัด
          </p>
          <p>
            เจ้าของงานอัดเสียงตามสคริปต์ในเบราว์เซอร์ อัดใหม่เฉพาะประโยคที่ไม่พอใจ ระบบเรียงภาพให้ตรงกับแต่ละประโยค ใส่ซับไทย
            แล้วปรับจังหวะอีกเล็กน้อยในไทม์ไลน์ก่อนดาวน์โหลด
          </p>
        </div>
      </div>

      <div className="bottom-cta">
        <p>อยากเห็นคลิปแนวของคุณเองว่าออกมาเป็นยังไง ลองตัดคลิปแรกด้วยแพลนฟรีได้เลย</p>
        <Link href="/signup" className="btn btn-primary btn-lg">
          เริ่มใช้ฟรี
        </Link>
      </div>

      <JsonLd data={jsonLd} />
    </main>
  );
}
