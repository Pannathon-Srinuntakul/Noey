"use client";

import { useCallback, useEffect, useRef, useState, useTransition } from "react";
import {
  getBlogOverviewAction,
  getBlogPostAction,
  publishBlogPostAction,
  revokeConnectorAction,
  saveBlogPostAction,
  saveBlogSettingsAction,
  type ActionResult,
} from "@/app/actions";
import {
  ACTION_LABEL,
  LIMITS,
  REVOKE_REASON,
  SOURCE_LABEL,
  STATUS_LABEL,
  editProblems,
  formatTags,
  parseTags,
  thaiDate,
  type BlogOverview,
  type Category,
  type FaqItem,
  type PostEdit,
  type PostFull,
  type PostSource,
  type PostStatus,
} from "@/lib/blog";
import { BlogPlanning } from "./BlogPlanning";
import { MarkdownPreview } from "./MarkdownPreview";
import { LOSS, OK, Seg, type ConfirmSpec } from "./ui";

type Handle = <T>(r: ActionResult<T>) => r is { ok: true; data: T };

const label: React.CSSProperties = { display: "block", fontSize: 12.5, color: "var(--color-neutral-700)", margin: "12px 0 5px" };
const statusColor: Record<PostStatus, string> = { draft: "var(--color-neutral-700)", published: OK, unpublished: LOSS };

/** The newest value of a prop for use inside a memoised loader, so a parent
 * that re-creates its callback each render does not re-trigger the load. */
function useLatest<T>(value: T) {
  const ref = useRef(value);
  useEffect(() => {
    ref.current = value;
  });
  return ref;
}

function Count({ value, max }: { value: string; max: number }) {
  const over = value.length > max;
  return <span className="num" style={{ float: "right", fontSize: 11.5, color: over ? LOSS : "var(--color-neutral-500)" }}>{value.length}/{max}</span>;
}

function toEdit(p: PostFull): PostEdit {
  return {
    title: p.title, meta_title: p.meta_title, meta_description: p.meta_description, excerpt: p.excerpt,
    content_md: p.content_md, cover_image_url: p.cover_image_url, cover_alt: p.cover_alt, category: p.category.slug,
    tags: p.tags.map((t) => ({ slug: t.slug, name: t.name })), faq: p.faq.map((f) => ({ ...f })), new_slug: p.slug,
  };
}

function PostDrawer({
  slug, categories, handle, ask, done, onChanged, onClose,
}: {
  slug: string;
  categories: Category[];
  handle: Handle;
  ask: (c: ConfirmSpec) => void;
  done: (msg: string) => void;
  onChanged: () => void;
  onClose: () => void;
}) {
  const [post, setPost] = useState<PostFull | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [mode, setMode] = useState<"preview" | "edit">("preview");
  const [draft, setDraft] = useState<PostEdit | null>(null);
  const [tagsText, setTagsText] = useState("");
  const closeRef = useRef<HTMLButtonElement>(null);
  const latestHandle = useLatest(handle);

  const load = useCallback(async () => {
    const r = await getBlogPostAction(slug);
    if (r.ok) {
      setPost(r.data);
      setDraft(toEdit(r.data));
      setTagsText(formatTags(r.data.tags));
      setError(null);
    } else if (r.signedOut) latestHandle.current(r);
    else setError(r.error);
  }, [slug, latestHandle]);

  const [, startLoad] = useTransition();
  useEffect(() => {
    closeRef.current?.focus();
    startLoad(load);
  }, [load]);

  const problems = draft ? editProblems({ ...draft, tags: parseTags(tagsText) }) : [];
  const setField = <K extends keyof PostEdit>(k: K, v: PostEdit[K]) => setDraft((d) => (d ? { ...d, [k]: v } : d));
  const setFaq = (i: number, f: Partial<FaqItem>) =>
    setDraft((d) => (d ? { ...d, faq: d.faq.map((x, j) => (j === i ? { ...x, ...f } : x)) } : d));

  const publishToggle = () => {
    if (!post) return;
    const publish = post.status !== "published";
    ask({
      title: publish ? "เผยแพร่บทความ" : "ถอนบทความออกจากเว็บ",
      body: post.title,
      lines: publish
        ? [`/blog/${post.slug}`, post.published_at ? "เคยเผยแพร่แล้ว — ลิงก์เดิมกลับมาใช้ได้" : "slug จะถูกล็อกหลังเผยแพร่ครั้งแรก", "ไม่นับรวมเพดานต่อวันของ AI"]
        : ["บทความหายจากเว็บ แผนผังเว็บ และฟีด", "ข้อมูลยังเก็บไว้ เผยแพร่กลับได้ทุกเมื่อ"],
      okLabel: publish ? "เผยแพร่" : "ถอนบทความ",
      danger: !publish,
      ok: async () => {
        const r = await publishBlogPostAction(post.slug, publish);
        if (!handle(r)) return;
        setPost(r.data.post);
        onChanged();
        done(publish ? "เผยแพร่แล้ว" : "ถอนบทความแล้ว");
      },
    });
  };

  const save = () => {
    if (!post || !draft) return;
    const edit = { ...draft, tags: parseTags(tagsText), new_slug: post.slug_locked ? undefined : draft.new_slug };
    ask({
      title: "บันทึกการแก้ไข",
      body: post.title,
      lines: [
        "บทความจะกลายเป็นของเจ้าของเว็บ (แก้โดยคน) — AI แก้ไขบทความนี้ต่อไม่ได้อีก",
        post.status === "published" ? "บทความเผยแพร่อยู่ หน้าเว็บจะอัปเดตทันที" : "ยังเป็นฉบับร่างจนกว่าจะเผยแพร่",
        ...(edit.new_slug && edit.new_slug !== post.slug ? [`slug ${post.slug} → ${edit.new_slug}`] : []),
      ],
      okLabel: "บันทึก",
      ok: async () => {
        const r = await saveBlogPostAction(post.slug, edit);
        if (!handle(r)) return;
        setPost(r.data);
        setDraft(toEdit(r.data));
        setTagsText(formatTags(r.data.tags));
        setMode("preview");
        onChanged();
        done("บันทึกแล้ว");
      },
    });
  };

  return (
    <>
      <div className="scrim" onClick={onClose} />
      <aside className="drawer" role="dialog" aria-modal="true" aria-labelledby="post-title" style={{ width: 760 }}>
        <div style={{ display: "flex", alignItems: "flex-start", gap: 14, padding: "20px 24px 14px", borderBottom: "1px solid var(--color-divider)" }}>
          <div style={{ flex: 1, minWidth: 0 }}>
            <p id="post-title" style={{ margin: 0, fontSize: 19, fontWeight: 500 }}>{post?.title ?? slug}</p>
            {post && (
              <p className="num" style={{ margin: "4px 0 0", fontSize: 12.5, color: "var(--color-neutral-600)", wordBreak: "break-all" }}>
                <span style={{ color: statusColor[post.status] }}>{STATUS_LABEL[post.status]}</span> · {SOURCE_LABEL[post.source]} · /blog/{post.slug}
                {post.slug_locked && " (ล็อกแล้ว)"} · อ่าน {post.reading_minutes} นาที · สร้างโดย {post.created_by}
              </p>
            )}
          </div>
          <button ref={closeRef} type="button" className="btn btn-secondary btn-icon" onClick={onClose} aria-label="ปิด">✕</button>
        </div>
        {error && <p role="alert" className="err" style={{ padding: "16px 24px", margin: 0 }}>{error}</p>}
        {post && draft && (
          <div style={{ padding: "16px 24px 28px" }}>
            <div style={{ display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap" }}>
              <Seg label="มุมมอง" value={mode} onChange={setMode} options={[{ value: "preview", label: "ดูตัวอย่าง" }, { value: "edit", label: "แก้ไข" }]} />
              <span style={{ flex: 1 }} />
              <button type="button" className={`btn btn-secondary${post.status === "published" ? " btn-danger" : ""}`} onClick={publishToggle} style={{ fontFamily: "inherit", fontSize: 13 }}>
                {post.status === "published" ? "ถอนบทความ" : "เผยแพร่"}
              </button>
            </div>

            {mode === "preview" ? (
              <div style={{ marginTop: 18 }}>
                <p className="small" style={{ margin: 0 }}>Meta title: {post.meta_title}</p>
                <p className="small" style={{ margin: "2px 0 0" }}>Meta description: {post.meta_description}</p>
                <p className="small" style={{ margin: "2px 0 12px" }}>
                  หมวด {post.category.name} · แท็ก {post.tags.map((t) => t.name).join(", ") || "—"}
                </p>
                {post.cover_image_url && (
                  // eslint-disable-next-line @next/next/no-img-element -- remote WebP from the blog store
                  <img src={post.cover_image_url} alt={post.cover_alt ?? ""} style={{ maxWidth: "100%", height: "auto", borderRadius: 4, marginBottom: 14 }} />
                )}
                <h1 style={{ fontSize: 24, fontWeight: 500, margin: "0 0 8px" }}>{post.title}</h1>
                <p style={{ margin: "0 0 18px", color: "var(--color-neutral-700)" }}>{post.excerpt}</p>
                <MarkdownPreview markdown={post.content_md} media={post.media} />
                {post.faq.length > 0 && (
                  <>
                    <h2 style={{ fontSize: 19, fontWeight: 500, margin: "22px 0 8px" }}>คำถามที่พบบ่อย</h2>
                    {post.faq.map((f, i) => (
                      <div key={i} style={{ marginBottom: 10 }}>
                        <p style={{ margin: 0, fontWeight: 500 }}>{f.question}</p>
                        <p style={{ margin: "2px 0 0" }}>{f.answer}</p>
                      </div>
                    ))}
                  </>
                )}
              </div>
            ) : (
              <div style={{ marginTop: 6 }}>
                <label style={label} htmlFor="b-title">ชื่อบทความ <Count value={draft.title} max={LIMITS.title} /></label>
                <input id="b-title" className="input" value={draft.title} onChange={(e) => setField("title", e.target.value)} style={{ fontFamily: "inherit" }} />
                {!post.slug_locked && (
                  <>
                    <label style={label} htmlFor="b-slug">slug (เปลี่ยนได้จนกว่าจะเผยแพร่ครั้งแรก)</label>
                    <input id="b-slug" className="input" value={draft.new_slug ?? ""} onChange={(e) => setField("new_slug", e.target.value.trim().toLowerCase())} style={{ fontFamily: "inherit" }} />
                  </>
                )}
                <label style={label} htmlFor="b-mt">Meta title <Count value={draft.meta_title} max={LIMITS.meta_title} /></label>
                <input id="b-mt" className="input" value={draft.meta_title} onChange={(e) => setField("meta_title", e.target.value)} style={{ fontFamily: "inherit" }} />
                <label style={label} htmlFor="b-md">Meta description <Count value={draft.meta_description} max={LIMITS.meta_description} /></label>
                <textarea id="b-md" className="input" rows={2} value={draft.meta_description} onChange={(e) => setField("meta_description", e.target.value)} style={{ fontFamily: "inherit", resize: "vertical" }} />
                <label style={label} htmlFor="b-ex">บทคัดย่อ <Count value={draft.excerpt} max={LIMITS.excerpt} /></label>
                <textarea id="b-ex" className="input" rows={3} value={draft.excerpt} onChange={(e) => setField("excerpt", e.target.value)} style={{ fontFamily: "inherit", resize: "vertical" }} />
                <label style={label} htmlFor="b-cat">หมวดหมู่</label>
                <select id="b-cat" className="input" value={draft.category} onChange={(e) => setField("category", e.target.value)} style={{ fontFamily: "inherit" }}>
                  {categories.map((c) => <option key={c.slug} value={c.slug}>{c.name}</option>)}
                </select>
                <label style={label} htmlFor="b-tags">แท็ก (คั่นด้วยจุลภาค · slug:ชื่อ เช่น subtitles:ซับไทย)</label>
                <input id="b-tags" className="input" value={tagsText} onChange={(e) => setTagsText(e.target.value)} style={{ fontFamily: "inherit" }} />
                <label style={label} htmlFor="b-cover">รูปปก (URL ภาพปกที่ AI สร้าง หรือรูปจากคลังสื่อ)</label>
                <input id="b-cover" className="input" value={draft.cover_image_url ?? ""} onChange={(e) => setField("cover_image_url", e.target.value || null)} style={{ fontFamily: "inherit" }} />
                <label style={label} htmlFor="b-alt">คำอธิบายรูปปก</label>
                <input id="b-alt" className="input" value={draft.cover_alt ?? ""} onChange={(e) => setField("cover_alt", e.target.value || null)} style={{ fontFamily: "inherit" }} />
                <label style={label} htmlFor="b-body">เนื้อหา (Markdown · หัวข้อเริ่มที่ ## · ห้าม HTML)</label>
                <textarea id="b-body" className="input" rows={18} value={draft.content_md} onChange={(e) => setField("content_md", e.target.value)} style={{ fontFamily: "ui-monospace, monospace", fontSize: 12.5, resize: "vertical" }} />
                <p style={{ ...label, marginTop: 16 }}>คำถามที่พบบ่อย ({draft.faq.length}/{LIMITS.faqMax})</p>
                {draft.faq.map((f, i) => (
                  <div key={i} style={{ display: "grid", gap: 6, marginBottom: 10, gridTemplateColumns: "1fr auto" }}>
                    <input className="input" aria-label={`คำถามข้อ ${i + 1}`} value={f.question} onChange={(e) => setFaq(i, { question: e.target.value })} style={{ fontFamily: "inherit" }} />
                    <button type="button" className="remove-btn" aria-label={`ลบคำถามข้อ ${i + 1}`} onClick={() => setDraft((d) => (d ? { ...d, faq: d.faq.filter((_, j) => j !== i) } : d))}>✕</button>
                    <textarea className="input" aria-label={`คำตอบข้อ ${i + 1}`} rows={2} value={f.answer} onChange={(e) => setFaq(i, { answer: e.target.value })} style={{ fontFamily: "inherit", gridColumn: "1 / span 2", resize: "vertical" }} />
                  </div>
                ))}
                {draft.faq.length < LIMITS.faqMax && (
                  <button type="button" className="btn btn-ghost" onClick={() => setDraft((d) => (d ? { ...d, faq: [...d.faq, { question: "", answer: "" }] } : d))} style={{ fontFamily: "inherit", fontSize: 13 }}>
                    + เพิ่มคำถาม
                  </button>
                )}
                {problems.length > 0 && (
                  <ul className="err" style={{ fontSize: 12.5, margin: "14px 0 0", paddingLeft: 18 }}>{problems.map((p) => <li key={p}>{p}</li>)}</ul>
                )}
                <div className="sticky-save">
                  <span className="small" style={{ flex: 1 }}>บันทึกแล้วบทความจะเป็นของเจ้าของเว็บ AI แก้ต่อไม่ได้</span>
                  <button type="button" className="btn btn-secondary" onClick={() => { setDraft(toEdit(post)); setTagsText(formatTags(post.tags)); }} style={{ fontFamily: "inherit", fontSize: 13 }}>ยกเลิก</button>
                  <button type="button" className="btn btn-primary" disabled={problems.length > 0} onClick={save} style={{ fontFamily: "inherit", fontSize: 13 }}>บันทึก</button>
                </div>
              </div>
            )}
          </div>
        )}
      </aside>
    </>
  );
}

export function BlogTab({
  handle, ask, done, active,
}: {
  handle: Handle;
  ask: (c: ConfirmSpec) => void;
  done: (msg: string) => void;
  /** Escape closes the drawer only while no confirm dialog is open. */
  active: boolean;
}) {
  const [status, setStatus] = useState<PostStatus | "">("");
  const [source, setSource] = useState<PostSource | "">("");
  const [data, setData] = useState<BlogOverview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, start] = useTransition();
  const [open, setOpen] = useState<string | null>(null);
  const [cap, setCap] = useState<number | null>(null);
  const latestHandle = useLatest(handle);

  const load = useCallback(() => {
    start(async () => {
      const r = await getBlogOverviewAction(status, source);
      if (r.ok) {
        setData(r.data);
        setError(null);
      } else if (r.signedOut) latestHandle.current(r);
      else setError(r.error);
    });
  }, [status, source, latestHandle]);

  useEffect(() => load(), [load]);

  useEffect(() => {
    if (open === null || !active) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") setOpen(null); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, active]);

  const settings = data?.settings;

  const saveSettings = (autoPublish: boolean | null, maxPerDay: number | null) => {
    ask({
      title: "ตั้งค่าการเผยแพร่อัตโนมัติ",
      body: "ใช้กับการเรียกผ่านตัวเชื่อมต่อ AI เท่านั้น การเผยแพร่จากหน้านี้ไม่ถูกจำกัด",
      lines: [
        autoPublish === null ? "เผยแพร่อัตโนมัติ: ใช้ค่าตั้งต้นของเซิร์ฟเวอร์" : autoPublish ? "เผยแพร่อัตโนมัติ: เปิด" : "เผยแพร่อัตโนมัติ: ปิด — บทความรอเจ้าของอนุมัติ",
        maxPerDay === null ? "เพดานต่อวัน: ใช้ค่าตั้งต้นของเซิร์ฟเวอร์" : `เพดานต่อวัน: ${maxPerDay} บทความ (นับตามเวลาไทย)`,
      ],
      okLabel: "บันทึก",
      ok: async () => {
        const r = await saveBlogSettingsAction(autoPublish, maxPerDay);
        if (!handle(r)) return;
        setData((d) => (d ? { ...d, settings: r.data } : d));
        setCap(null);
        done("บันทึกการตั้งค่าแล้ว");
      },
    });
  };

  const revoke = (grantId: number, name: string) =>
    ask({
      title: "ยกเลิกตัวเชื่อมต่อ",
      body: name,
      lines: ["โทเค็นทั้งหมดของตัวเชื่อมต่อนี้ใช้ไม่ได้ทันที", "ต้องเชื่อมต่อและอนุมัติใหม่ถ้าจะใช้อีก"],
      okLabel: "ยกเลิกตัวเชื่อมต่อ",
      danger: true,
      ok: async () => {
        const r = await revokeConnectorAction(grantId);
        if (!handle(r)) return;
        load();
        done("ยกเลิกตัวเชื่อมต่อแล้ว");
      },
    });

  return (
    <div className={loading ? "loading" : undefined}>
      {error && <p role="alert" className="err" style={{ margin: "0 0 16px", fontSize: 13 }}>{error}</p>}

      {settings && (
        <div className="card" style={{ marginBottom: 20 }}>
          <p className="card-title">การเผยแพร่โดย AI</p>
          <p className="card-sub">AI เขียนบทความผ่านตัวเชื่อมต่อ บทความใหม่เป็นฉบับร่างเสมอ</p>
          <div style={{ display: "flex", gap: 22, alignItems: "center", flexWrap: "wrap", marginTop: 14, fontSize: 13 }}>
            <span style={{ display: "flex", alignItems: "center", gap: 10 }}>
              เผยแพร่อัตโนมัติ
              <Seg
                label="เผยแพร่อัตโนมัติ"
                value={settings.auto_publish ? "on" : "off"}
                onChange={(v) => saveSettings(v === "on", settings.max_per_day_source === "admin" ? settings.max_per_day : null)}
                options={[{ value: "on", label: "เปิด" }, { value: "off", label: "ปิด (รออนุมัติ)" }]}
              />
            </span>
            <span style={{ display: "flex", alignItems: "center", gap: 8 }}>
              เพดานต่อวัน
              <input
                className="input num"
                type="number"
                aria-label="เพดานบทความต่อวัน"
                min={0}
                max={50}
                value={cap ?? settings.max_per_day}
                onChange={(e) => setCap(Math.max(0, Math.min(50, Math.round(Number(e.target.value) || 0))))}
                style={{ width: 70, fontFamily: "inherit", textAlign: "right" }}
              />
              {cap !== null && cap !== settings.max_per_day && (
                <button type="button" className="btn btn-secondary" onClick={() => saveSettings(settings.auto_publish_source === "admin" ? settings.auto_publish : null, cap)} style={{ fontFamily: "inherit", fontSize: 13 }}>
                  บันทึก
                </button>
              )}
            </span>
            <span className="num small">วันนี้ AI เผยแพร่แล้ว {settings.published_today_via_mcp}/{settings.max_per_day} · นับใหม่ {thaiDate(settings.next_reset_at)}</span>
            {(settings.auto_publish_source === "admin" || settings.max_per_day_source === "admin") && (
              <button type="button" className="btn btn-ghost" onClick={() => saveSettings(null, null)} style={{ fontFamily: "inherit", fontSize: 13 }}>
                ใช้ค่าตั้งต้นของเซิร์ฟเวอร์
              </button>
            )}
          </div>
        </div>
      )}

      <BlogPlanning handle={handle} ask={ask} done={done} />

      <div style={{ display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap", marginBottom: 14 }}>
        <Seg
          label="สถานะ"
          value={status || "all"}
          onChange={(v) => setStatus(v === "all" ? "" : (v as PostStatus))}
          options={[{ value: "all", label: "ทุกสถานะ" }, { value: "draft", label: "ฉบับร่าง" }, { value: "published", label: "เผยแพร่แล้ว" }, { value: "unpublished", label: "ถอนแล้ว" }]}
        />
        <Seg
          label="ผู้เขียน"
          value={source || "all"}
          onChange={(v) => setSource(v === "all" ? "" : (v as PostSource))}
          options={[{ value: "all", label: "ทั้งหมด" }, { value: "ai", label: "AI เขียน" }, { value: "human", label: "เจ้าของแก้" }]}
        />
        <span className="small num" style={{ marginLeft: "auto" }}>{data ? `${data.total} บทความ` : "กำลังโหลด…"}</span>
      </div>

      <div style={{ border: "1px solid var(--color-divider)", borderRadius: 4, overflow: "auto" }}>
        <table className="table" style={{ fontFamily: "inherit", fontSize: 13.5, minWidth: 860 }}>
          <thead>
            <tr>
              <th style={{ paddingLeft: 16 }}>บทความ</th><th>สถานะ</th><th>ผู้เขียน</th><th>หมวด</th><th style={{ textAlign: "right", paddingRight: 16 }}>เผยแพร่</th>
            </tr>
          </thead>
          <tbody>
            {data?.posts.map((p) => (
              <tr key={p.slug} className="clickable-row" tabIndex={0} onClick={() => setOpen(p.slug)}
                onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); setOpen(p.slug); } }}>
                <td style={{ paddingLeft: 16 }}>
                  <span style={{ display: "block" }}>{p.title}</span>
                  <span style={{ display: "block", fontSize: 12, color: "var(--color-neutral-600)" }}>/blog/{p.slug}</span>
                </td>
                <td style={{ color: statusColor[p.status] }}>{STATUS_LABEL[p.status]}</td>
                <td><span className={`tag ${p.source === "ai" ? "tag-accent" : "tag-neutral"}`}>{SOURCE_LABEL[p.source]}</span></td>
                <td>{p.category.name}</td>
                <td className="num" style={{ textAlign: "right", paddingRight: 16 }}>{thaiDate(p.published_at)}</td>
              </tr>
            ))}
            {data && data.posts.length === 0 && (
              <tr><td colSpan={5} style={{ padding: 18, textAlign: "center", color: "var(--color-neutral-600)" }}>ยังไม่มีบทความ</td></tr>
            )}
          </tbody>
        </table>
      </div>

      <div className="grid" style={{ gridTemplateColumns: "repeat(auto-fit, minmax(420px, 1fr))" }}>
        <div className="card">
          <p className="card-title">ตัวเชื่อมต่อ AI ที่ได้รับอนุญาต</p>
          <p className="card-sub">ตัวเชื่อมต่อที่คุณกดอนุญาตในหน้ายืนยัน · ยกเลิกแล้วใช้ไม่ได้ทันที</p>
          {data && data.connectors.length === 0 && <p className="small" style={{ marginTop: 12 }}>ยังไม่มีตัวเชื่อมต่อ</p>}
          {data?.connectors.map((g) => (
            <div key={g.grant_id} style={{ display: "flex", gap: 12, alignItems: "center", padding: "10px 0", borderTop: "1px solid var(--color-divider)", marginTop: 8, opacity: g.active ? 1 : 0.55 }}>
              <div style={{ flex: 1, minWidth: 0, fontSize: 13 }}>
                <span style={{ display: "block", fontWeight: 500 }}>{g.client_name}</span>
                <span className="num" style={{ display: "block", fontSize: 12, color: "var(--color-neutral-600)" }}>
                  ส่งกลับไปที่ {g.redirect_hosts.join(", ")} · อนุญาตโดย {g.approved_by} · {thaiDate(g.created_at)} · ใช้ล่าสุด {thaiDate(g.last_used_at)}
                  {!g.active && ` · ยกเลิกแล้ว (${REVOKE_REASON[g.revoked_reason ?? ""] ?? g.revoked_reason ?? ""})`}
                </span>
              </div>
              {g.active && (
                <button type="button" className="btn btn-secondary btn-danger" onClick={() => revoke(g.grant_id, g.client_name)} style={{ fontFamily: "inherit", fontSize: 12.5 }}>
                  ยกเลิก
                </button>
              )}
            </div>
          ))}
        </div>

        <div className="card">
          <p className="card-title">บันทึกการเปลี่ยนแปลง</p>
          <p className="card-sub">ทุกการเขียนผ่านตัวเชื่อมต่อและผ่านหน้านี้ 100 รายการล่าสุด</p>
          <div style={{ maxHeight: 420, overflowY: "auto", marginTop: 8 }}>
            {data?.audit.map((a) => (
              <div key={a.id} className="num" style={{ display: "flex", gap: 10, padding: "7px 0", borderTop: "1px solid var(--color-divider)", fontSize: 12.5 }}>
                <span style={{ width: 118, flexShrink: 0, color: "var(--color-neutral-600)" }}>{thaiDate(a.at)}</span>
                <span style={{ flex: 1, minWidth: 0 }}>
                  <span style={{ color: a.ok ? undefined : LOSS }}>{ACTION_LABEL[a.action] ?? a.action}{a.ok ? "" : " (ถูกปฏิเสธ)"}</span>
                  {a.slug && <span style={{ color: "var(--color-neutral-600)" }}> · {a.slug}</span>}
                  <span style={{ display: "block", color: "var(--color-neutral-500)", wordBreak: "break-all" }}>{a.actor}</span>
                </span>
              </div>
            ))}
          </div>
        </div>
      </div>

      {open && data && (
        <PostDrawer
          slug={open}
          categories={data.categories}
          handle={handle}
          ask={ask}
          done={done}
          onChanged={load}
          onClose={() => setOpen(null)}
        />
      )}
      {!data && !error && <p className="small" style={{ marginTop: 12 }}>กำลังโหลด…</p>}
    </div>
  );
}
