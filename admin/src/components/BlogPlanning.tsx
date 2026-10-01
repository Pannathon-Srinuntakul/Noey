"use client";

import { useCallback, useEffect, useRef, useState, useTransition } from "react";
import {
  addTopicAction,
  deleteTopicAction,
  getPlanningAction,
  reorderPlanAction,
  saveBriefAction,
  updateTopicAction,
  type ActionResult,
} from "@/app/actions";
import {
  BRIEF_FIELDS,
  PLAN_STATUS_LABEL,
  moveInPlan,
  thaiDate,
  validSlug,
  type Brief,
  type PlanItem,
  type PlanStatus,
} from "@/lib/blog";
import { OK, type ConfirmSpec } from "./ui";

type Handle = <T>(r: ActionResult<T>) => r is { ok: true; data: T };
const label: React.CSSProperties = { display: "block", fontSize: 12.5, color: "var(--color-neutral-700)", margin: "12px 0 5px" };
const STATUSES = Object.keys(PLAN_STATUS_LABEL) as PlanStatus[];

/**
 * The owner's guidance for the AI writer (บทความ → Writing brief / Content
 * plan). The writer reads both through get_site_info — the brief with its
 * updated_at, and only the topics not written yet, in this order — and links
 * a topic to its post with mark_topic_done.
 */
export function BlogPlanning({ handle, ask, done }: { handle: Handle; ask: (c: ConfirmSpec) => void; done: (msg: string) => void }) {
  const [brief, setBrief] = useState<Brief | null>(null);
  const [draft, setDraft] = useState<Brief | null>(null);
  const [plan, setPlan] = useState<PlanItem[] | null>(null);
  const [topic, setTopic] = useState("");
  const [notes, setNotes] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, start] = useTransition();
  const handleRef = useRef(handle);
  useEffect(() => {
    handleRef.current = handle;
  });

  const load = useCallback(() => {
    start(async () => {
      const r = await getPlanningAction();
      if (r.ok) {
        setBrief(r.data.brief);
        setDraft(r.data.brief);
        setPlan(r.data.plan);
        setError(null);
      } else if (r.signedOut) handleRef.current(r);
      else setError(r.error);
    });
  }, []);
  useEffect(() => load(), [load]);

  const dirty = !!brief && !!draft && BRIEF_FIELDS.some((f) => brief[f.key] !== draft[f.key]);

  const saveBrief = () => {
    if (!draft) return;
    ask({
      title: "บันทึก Writing brief",
      body: "AI จะเห็น brief ใหม่ในการเขียนบทความครั้งถัดไป",
      lines: BRIEF_FIELDS.filter((f) => brief && brief[f.key] !== draft[f.key]).map((f) => `${f.label}: เปลี่ยนแล้ว`),
      okLabel: "บันทึก",
      ok: async () => {
        const { updated_at: _ignored, ...fields } = draft;
        void _ignored;
        const r = await saveBriefAction(fields);
        if (!handle(r)) return;
        setBrief(r.data);
        setDraft(r.data);
        done("บันทึก brief แล้ว");
      },
    });
  };

  const run = (fn: () => Promise<ActionResult<unknown>>, msg: string) =>
    start(async () => {
      const r = await fn();
      if (!handle(r)) return;
      load();
      done(msg);
    });

  const ids = plan?.map((p) => p.id) ?? [];

  return (
    <div className="grid" style={{ gridTemplateColumns: "repeat(auto-fit, minmax(420px, 1fr))", marginBottom: 20 }}>
      <div className="card">
        <p className="card-title">Writing brief</p>
        <p className="card-sub">แนวทางที่ AI อ่านก่อนเขียนทุกครั้ง · แก้ล่าสุด {thaiDate(brief?.updated_at ?? null)}</p>
        {error && <p role="alert" className="err" style={{ fontSize: 13 }}>{error}</p>}
        {draft &&
          BRIEF_FIELDS.map((f) => (
            <div key={f.key}>
              <label style={label} htmlFor={`brief-${f.key}`}>
                {f.label}
                <span className="num" style={{ float: "right", fontSize: 11.5, color: draft[f.key].length > f.max ? "var(--color-danger, #a33a34)" : "var(--color-neutral-500)" }}>
                  {draft[f.key].length}/{f.max}
                </span>
              </label>
              <textarea
                id={`brief-${f.key}`}
                className="input"
                rows={f.rows}
                placeholder={f.hint}
                value={draft[f.key]}
                onChange={(e) => setDraft((d) => (d ? { ...d, [f.key]: e.target.value } : d))}
                style={{ fontFamily: "inherit", resize: "vertical" }}
              />
            </div>
          ))}
        <div style={{ display: "flex", gap: 8, marginTop: 14 }}>
          <button type="button" className="btn btn-primary" disabled={!dirty || busy} onClick={saveBrief} style={{ fontFamily: "inherit", fontSize: 13 }}>บันทึก brief</button>
          {dirty && <button type="button" className="btn btn-secondary" onClick={() => setDraft(brief)} style={{ fontFamily: "inherit", fontSize: 13 }}>ยกเลิก</button>}
        </div>
      </div>

      <div className="card">
        <p className="card-title">Content plan</p>
        <p className="card-sub">หัวข้อเรียงตามลำดับ · AI เขียนหัวข้อแรกที่ยังรอเขียน แล้วผูกกับบทความด้วย mark_topic_done</p>
        <div style={{ marginTop: 8 }}>
          {plan?.map((item, index) => (
            <div key={item.id} style={{ display: "grid", gridTemplateColumns: "auto 1fr auto", gap: 10, alignItems: "start", padding: "10px 0", borderTop: "1px solid var(--color-divider)" }}>
              <div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
                <button type="button" className="btn btn-ghost btn-icon" aria-label={`เลื่อน “${item.topic}” ขึ้น`} disabled={busy || index === 0} onClick={() => run(() => reorderPlanAction(moveInPlan(ids, item.id, -1)), "จัดลำดับแล้ว")}>↑</button>
                <button type="button" className="btn btn-ghost btn-icon" aria-label={`เลื่อน “${item.topic}” ลง`} disabled={busy || index === ids.length - 1} onClick={() => run(() => reorderPlanAction(moveInPlan(ids, item.id, 1)), "จัดลำดับแล้ว")}>↓</button>
              </div>
              <div style={{ minWidth: 0, fontSize: 13 }}>
                <span style={{ display: "block", fontWeight: 500 }}>{index + 1}. {item.topic}</span>
                {item.notes && <span style={{ display: "block", color: "var(--color-neutral-600)" }}>{item.notes}</span>}
                <span className="num" style={{ display: "block", fontSize: 12, color: item.status === "done" ? OK : "var(--color-neutral-600)" }}>
                  {PLAN_STATUS_LABEL[item.status]}
                  {item.post_slug ? ` · /blog/${item.post_slug}` : ""}
                  {item.done_at ? ` · ${thaiDate(item.done_at)}` : ""}
                </span>
              </div>
              <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
                <select
                  className="input"
                  aria-label={`สถานะของ “${item.topic}”`}
                  value={item.status}
                  disabled={busy}
                  onChange={(e) => run(() => updateTopicAction(item.id, { status: e.target.value as PlanStatus }), "เปลี่ยนสถานะแล้ว")}
                  style={{ fontFamily: "inherit", fontSize: 12.5, width: "auto" }}
                >
                  {STATUSES.map((s) => <option key={s} value={s}>{PLAN_STATUS_LABEL[s]}</option>)}
                </select>
                <button
                  type="button"
                  className="remove-btn"
                  aria-label={`ลบ “${item.topic}”`}
                  onClick={() =>
                    ask({
                      title: "ลบหัวข้อออกจากแผน",
                      body: item.topic,
                      lines: [item.post_slug ? `บทความ /blog/${item.post_slug} ยังอยู่ ลบแค่หัวข้อในแผน` : "ลบแค่หัวข้อในแผน"],
                      okLabel: "ลบหัวข้อ",
                      danger: true,
                      ok: async () => {
                        const r = await deleteTopicAction(item.id);
                        if (!handle(r)) return;
                        load();
                        done("ลบหัวข้อแล้ว");
                      },
                    })
                  }
                >
                  ✕
                </button>
              </div>
            </div>
          ))}
          {plan && plan.length === 0 && <p className="small" style={{ marginTop: 10 }}>ยังไม่มีหัวข้อในแผน — AI จะเลือกหัวข้อเองตาม brief</p>}
        </div>
        <label style={label} htmlFor="plan-topic">เพิ่มหัวข้อ</label>
        <input id="plan-topic" className="input" placeholder="เช่น วิธีทำซับไทยให้อ่านง่ายบนมือถือ" value={topic} onChange={(e) => setTopic(e.target.value)} style={{ fontFamily: "inherit" }} />
        <label style={label} htmlFor="plan-notes">หมายเหตุ (ไม่บังคับ)</label>
        <input id="plan-notes" className="input" placeholder="เช่น เน้นมือใหม่ ใส่ภาพหน้าจอจริง" value={notes} onChange={(e) => setNotes(e.target.value)} style={{ fontFamily: "inherit" }} />
        <button
          type="button"
          className="btn btn-secondary"
          disabled={busy || topic.trim().length < 3}
          onClick={() =>
            run(async () => {
              const r = await addTopicAction(topic, notes);
              if (r.ok) {
                setTopic("");
                setNotes("");
              }
              return r;
            }, "เพิ่มหัวข้อแล้ว")
          }
          style={{ fontFamily: "inherit", fontSize: 13, marginTop: 10 }}
        >
          + เพิ่มเข้าแผน
        </button>
        <LinkPost plan={plan} busy={busy} run={run} />
      </div>
    </div>
  );
}

/** Link a done topic to its post by hand (when it was written outside MCP). */
function LinkPost({ plan, busy, run }: { plan: PlanItem[] | null; busy: boolean; run: (fn: () => Promise<ActionResult<unknown>>, msg: string) => void }) {
  const [id, setId] = useState<number | "">("");
  const [slug, setSlug] = useState("");
  if (!plan?.length) return null;
  return (
    <details style={{ marginTop: 14, fontSize: 13 }}>
      <summary style={{ cursor: "pointer", color: "var(--color-neutral-700)" }}>ผูกหัวข้อกับบทความเอง</summary>
      <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginTop: 8 }}>
        <select className="input" aria-label="หัวข้อ" value={id} onChange={(e) => setId(e.target.value ? Number(e.target.value) : "")} style={{ fontFamily: "inherit", fontSize: 12.5, width: "auto", maxWidth: 260 }}>
          <option value="">เลือกหัวข้อ</option>
          {plan.map((p) => <option key={p.id} value={p.id}>{p.topic}</option>)}
        </select>
        <input className="input" aria-label="slug ของบทความ" placeholder="slug ของบทความ" value={slug} onChange={(e) => setSlug(e.target.value.trim().toLowerCase())} style={{ fontFamily: "inherit", fontSize: 12.5, width: 200 }} />
        <button
          type="button"
          className="btn btn-secondary"
          disabled={busy || id === "" || !validSlug(slug)}
          onClick={() => id !== "" && run(() => updateTopicAction(id, { status: "done", post_slug: slug }), "ผูกบทความแล้ว")}
          style={{ fontFamily: "inherit", fontSize: 12.5 }}
        >
          ผูกและปิดหัวข้อ
        </button>
      </div>
    </details>
  );
}
