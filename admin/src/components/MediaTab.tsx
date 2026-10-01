"use client";

import { useCallback, useEffect, useRef, useState, useTransition } from "react";
import { getMediaAction, updateMediaAction, uploadMediaAction, type ActionResult } from "@/app/actions";
import {
  MEDIA_ACCEPT,
  MEDIA_KIND_LABEL,
  MEDIA_MAX_MB,
  fileSize,
  mediaTextProblems,
  parseMediaTags,
  thaiDate,
  type MediaItem,
  type MediaKind,
} from "@/lib/blog";
import { Seg, type ConfirmSpec } from "./ui";

type Handle = <T>(r: ActionResult<T>) => r is { ok: true; data: T };

const label: React.CSSProperties = { display: "block", fontSize: 12.5, color: "var(--color-neutral-700)", margin: "12px 0 5px" };
const KINDS = Object.keys(MEDIA_KIND_LABEL) as MediaKind[];

function Thumb({ item }: { item: MediaItem }) {
  const box: React.CSSProperties = {
    width: "100%", aspectRatio: "16 / 10", borderRadius: 4, background: "var(--color-neutral-100)",
    display: "grid", placeItems: "center", overflow: "hidden", color: "var(--color-neutral-600)", fontSize: 12.5,
  };
  const src = item.type === "image" ? item.url : item.type === "video" ? item.poster_url : null;
  if (!src) return <div style={box}>PDF</div>;
  return (
    <div style={box}>
      {/* eslint-disable-next-line @next/next/no-img-element -- remote WebP from the blog store */}
      <img src={src} alt={item.alt} style={{ maxWidth: "100%", maxHeight: "100%", objectFit: "contain" }} />
    </div>
  );
}

function ItemCard({ item, handle, done, onChanged }: { item: MediaItem; handle: Handle; done: (m: string) => void; onChanged: () => void }) {
  const [alt, setAlt] = useState(item.alt);
  const [description, setDescription] = useState(item.description);
  const [tags, setTags] = useState(item.tags.join(", "));
  const [busy, start] = useTransition();
  const dirty = alt !== item.alt || description !== item.description || tags !== item.tags.join(", ");
  const problems = mediaTextProblems(alt, description);

  const save = (archived?: boolean) =>
    start(async () => {
      const r = await updateMediaAction(item.id, archived === undefined ? { alt, description, tags: parseMediaTags(tags) } : { archived });
      if (!handle(r)) return;
      onChanged();
      done(archived === undefined ? "บันทึกแล้ว" : archived ? "ซ่อนจาก AI แล้ว" : "นำกลับมาใช้แล้ว");
    });

  return (
    <div className="card" style={{ opacity: item.archived ? 0.6 : 1, padding: 14 }}>
      <Thumb item={item} />
      <p className="num small" style={{ margin: "8px 0 0", wordBreak: "break-all" }}>
        {item.kind ? MEDIA_KIND_LABEL[item.kind] : item.origin === "brand" ? "โลโก้ของเว็บ" : item.type}
        {item.width ? ` · ${item.width}×${item.height}` : ""}
        {item.duration_sec ? ` · ${item.duration_sec} วินาที` : ""} · {fileSize(item.bytes)} · {thaiDate(item.created_at)}
        {item.archived ? " · ซ่อนแล้ว" : ""}
      </p>
      <label style={label} htmlFor={`m-alt-${item.id}`}>คำอธิบายรูป (alt)</label>
      <input id={`m-alt-${item.id}`} className="input" value={alt} onChange={(e) => setAlt(e.target.value)} style={{ fontFamily: "inherit" }} />
      <label style={label} htmlFor={`m-desc-${item.id}`}>คำอธิบาย (ให้ AI รู้ว่าใช้ตอนไหน)</label>
      <textarea id={`m-desc-${item.id}`} className="input" rows={2} value={description} onChange={(e) => setDescription(e.target.value)} style={{ fontFamily: "inherit", resize: "vertical" }} />
      <label style={label} htmlFor={`m-tags-${item.id}`}>แท็ก (คั่นด้วยจุลภาค)</label>
      <input id={`m-tags-${item.id}`} className="input" value={tags} onChange={(e) => setTags(e.target.value)} style={{ fontFamily: "inherit" }} />
      {dirty && problems.length > 0 && <p className="err" style={{ fontSize: 12.5, margin: "8px 0 0" }}>{problems.join(" · ")}</p>}
      <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginTop: 12 }}>
        <button type="button" className="btn btn-primary" disabled={!dirty || problems.length > 0 || busy} onClick={() => save()} style={{ fontFamily: "inherit", fontSize: 12.5 }}>
          บันทึก
        </button>
        <button
          type="button"
          className="btn btn-secondary"
          onClick={() => {
            void navigator.clipboard?.writeText(item.markdown);
            done("คัดลอก Markdown แล้ว");
          }}
          style={{ fontFamily: "inherit", fontSize: 12.5 }}
        >
          คัดลอก Markdown
        </button>
        <a className="btn btn-ghost" href={item.url} target="_blank" rel="noopener noreferrer" style={{ fontFamily: "inherit", fontSize: 12.5 }}>เปิดไฟล์</a>
        <button type="button" className={`btn btn-secondary${item.archived ? "" : " btn-danger"}`} disabled={busy} onClick={() => save(!item.archived)} style={{ fontFamily: "inherit", fontSize: 12.5, marginLeft: "auto" }}>
          {item.archived ? "นำกลับมาใช้" : "ซ่อนจาก AI"}
        </button>
      </div>
    </div>
  );
}

function UploadCard({ handle, ask, done, onUploaded }: { handle: Handle; ask: (c: ConfirmSpec) => void; done: (m: string) => void; onUploaded: () => void }) {
  const [kind, setKind] = useState<MediaKind>("screenshot");
  const [alt, setAlt] = useState("");
  const [description, setDescription] = useState("");
  const [tags, setTags] = useState("");
  const [file, setFile] = useState<File | null>(null);
  const [error, setError] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const problems = [...mediaTextProblems(alt, description), ...(file ? [] : ["เลือกไฟล์"])];
  const tooBig = file && file.size > MEDIA_MAX_MB[kind] * 1024 * 1024;

  const upload = () => {
    if (!file) return;
    ask({
      title: "อัปโหลดเข้าคลังสื่อ",
      body: file.name,
      lines: [
        `${MEDIA_KIND_LABEL[kind]} · ${fileSize(file.size)}`,
        kind === "demo" ? "วิดีโอจะถูกแปลงเป็น MP4 (H.264) ไม่มีเสียง และตัดข้อมูลแฝงออก" : kind === "file" ? "PDF จะเปิดเป็นไฟล์ดาวน์โหลดเท่านั้น" : "รูปจะถูกแปลงเป็น WebP และตัดข้อมูลแฝง (EXIF/GPS) ออก",
        "AI ที่เขียนบทความจะเห็นไฟล์นี้ผ่าน list_media",
      ],
      okLabel: "อัปโหลด",
      ok: async () => {
        const form = new FormData();
        form.set("file", file);
        form.set("kind", kind);
        form.set("alt", alt);
        form.set("description", description);
        form.set("tags", tags);
        const r = await uploadMediaAction(form);
        if (!r.ok && !r.signedOut) {
          setError(r.error);
          done("อัปโหลดไม่สำเร็จ");
          return;
        }
        if (!handle(r)) return;
        setAlt("");
        setDescription("");
        setTags("");
        setFile(null);
        setError(null);
        if (fileRef.current) fileRef.current.value = "";
        onUploaded();
        done("อัปโหลดแล้ว");
      },
    });
  };

  return (
    <div className="card" style={{ marginBottom: 20 }}>
      <p className="card-title">อัปโหลดสื่อจริง</p>
      <p className="card-sub">ภาพหน้าจอ คลิปสาธิต โลโก้ และไฟล์ PDF ที่ AI ใช้ประกอบบทความได้ · ตรวจชนิดไฟล์จากเนื้อไฟล์ทุกครั้ง</p>
      <div style={{ marginTop: 12 }}>
        <Seg label="ประเภทสื่อ" value={kind} onChange={(v) => setKind(v as MediaKind)} options={KINDS.map((k) => ({ value: k, label: MEDIA_KIND_LABEL[k] }))} />
      </div>
      <label style={label} htmlFor="u-file">ไฟล์ (สูงสุด {MEDIA_MAX_MB[kind]} MB)</label>
      <input id="u-file" ref={fileRef} type="file" accept={MEDIA_ACCEPT[kind]} onChange={(e) => setFile(e.target.files?.[0] ?? null)} style={{ fontFamily: "inherit", fontSize: 13 }} />
      <label style={label} htmlFor="u-alt">คำอธิบายรูป (alt) — สิ่งที่อยู่ในภาพ</label>
      <input id="u-alt" className="input" value={alt} onChange={(e) => setAlt(e.target.value)} style={{ fontFamily: "inherit" }} />
      <label style={label} htmlFor="u-desc">คำอธิบาย — ใช้ประกอบเรื่องอะไร</label>
      <textarea id="u-desc" className="input" rows={2} value={description} onChange={(e) => setDescription(e.target.value)} style={{ fontFamily: "inherit", resize: "vertical" }} />
      <label style={label} htmlFor="u-tags">แท็ก (คั่นด้วยจุลภาค เช่น timeline, ซับไทย)</label>
      <input id="u-tags" className="input" value={tags} onChange={(e) => setTags(e.target.value)} style={{ fontFamily: "inherit" }} />
      {(error || tooBig) && <p role="alert" className="err" style={{ fontSize: 13, margin: "10px 0 0" }}>{tooBig ? `ไฟล์ใหญ่เกิน ${MEDIA_MAX_MB[kind]} MB` : error}</p>}
      <div style={{ marginTop: 14 }}>
        <button type="button" className="btn btn-primary" disabled={problems.length > 0 || !!tooBig} onClick={upload} style={{ fontFamily: "inherit", fontSize: 13 }}>
          อัปโหลด
        </button>
        {problems.length > 0 && (file || alt) ? <span className="small" style={{ marginLeft: 10 }}>{problems.join(" · ")}</span> : null}
      </div>
    </div>
  );
}

export function MediaTab({ handle, ask, done }: { handle: Handle; ask: (c: ConfirmSpec) => void; done: (msg: string) => void }) {
  const [kind, setKind] = useState<MediaKind | "">("");
  const [archived, setArchived] = useState(false);
  const [items, setItems] = useState<MediaItem[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, start] = useTransition();
  const handleRef = useRef(handle);
  useEffect(() => {
    handleRef.current = handle;
  });

  const load = useCallback(() => {
    start(async () => {
      const r = await getMediaAction(kind, archived);
      if (r.ok) {
        setItems(r.data.items);
        setError(null);
      } else if (r.signedOut) handleRef.current(r);
      else setError(r.error);
    });
  }, [kind, archived]);

  useEffect(() => load(), [load]);

  return (
    <div className={loading ? "loading" : undefined}>
      <UploadCard handle={handle} ask={ask} done={done} onUploaded={load} />
      {error && <p role="alert" className="err" style={{ margin: "0 0 16px", fontSize: 13 }}>{error}</p>}
      <div style={{ display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap", marginBottom: 14 }}>
        <Seg
          label="ประเภท"
          value={kind || "all"}
          onChange={(v) => setKind(v === "all" ? "" : (v as MediaKind))}
          options={[{ value: "all", label: "ทั้งหมด" }, ...KINDS.map((k) => ({ value: k, label: MEDIA_KIND_LABEL[k] }))]}
        />
        <Seg label="แสดง" value={archived ? "all" : "active"} onChange={(v) => setArchived(v === "all")} options={[{ value: "active", label: "ที่ AI เห็น" }, { value: "all", label: "รวมที่ซ่อน" }]} />
        <span className="small num" style={{ marginLeft: "auto" }}>{items ? `${items.length} ไฟล์` : "กำลังโหลด…"}</span>
      </div>
      <div className="grid" style={{ gridTemplateColumns: "repeat(auto-fill, minmax(280px, 1fr))" }}>
        {items?.map((item) => <ItemCard key={`${item.id}-${item.archived}`} item={item} handle={handle} done={done} onChanged={load} />)}
      </div>
      {items && items.length === 0 && <p className="small" style={{ marginTop: 12 }}>ยังไม่มีสื่อในคลัง</p>}
    </div>
  );
}
