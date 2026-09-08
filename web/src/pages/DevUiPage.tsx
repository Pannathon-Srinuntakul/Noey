import { Download, Eye, Maximize2, Mic, Sparkles, Trash2 } from 'lucide-react'
import { useState } from 'react'
import { FirstRunPanel } from '../components/projects/FirstRunPanel'
import { TaskBreakdown } from '../components/settings/TaskBreakdown'
import { Button } from '../components/ui/Button'
import { Checkbox } from '../components/ui/Checkbox'
import { Chip } from '../components/ui/Chip'
import { Dialog } from '../components/ui/Dialog'
import { Input, Textarea } from '../components/ui/Input'
import { Menu } from '../components/ui/Menu'
import { Progress } from '../components/ui/Progress'
import { Select } from '../components/ui/Select'
import { Skeleton } from '../components/ui/Skeleton'
import { Slider } from '../components/ui/Slider'
import { StatusLine, type Status } from '../components/ui/StatusLine'
import { Switch } from '../components/ui/Switch'
import { Tabs } from '../components/ui/Tabs'
import { Toast } from '../components/ui/Toast'
import { Tooltip } from '../components/ui/Tooltip'

function Section({
  title,
  children
}: {
  title: string
  children: React.ReactNode
}): React.JSX.Element {
  return (
    <section className="border-b border-divider pb-8">
      <h2 className="mb-4 text-lg font-semibold text-ink-2">{title}</h2>
      <div className="flex flex-wrap items-start gap-4">{children}</div>
    </section>
  )
}

function Row({ children }: { children: React.ReactNode }): React.JSX.Element {
  return <div className="flex flex-wrap items-center gap-3">{children}</div>
}

/** Temporary preview page for `components/ui/*` — every primitive, every
 * state. See PLAN.md chunk 1. Route: `#/dev/ui`. Remove once every screen in
 * the redesign has shipped and the primitives are exercised for real. */
export default function DevUiPage(): React.JSX.Element {
  const [switchOn, setSwitchOn] = useState(true)
  const [checked, setChecked] = useState(true)
  const [slider, setSlider] = useState(22)
  const [platform, setPlatform] = useState('tiktok')
  const [tab, setTab] = useState('credit')
  const [dialogOpen, setDialogOpen] = useState(false)
  const [toastOpen, setToastOpen] = useState(false)
  const [menuOpen, setMenuOpen] = useState(false)

  return (
    <div className="scroll-ghost h-full w-full overflow-y-auto bg-ground p-8 text-ink">
      <h1 className="mb-1 text-[34px] font-semibold">/dev/ui</h1>
      <p className="mb-8 text-sm text-muted">components/ui/* — every state, per Component Kit</p>

      <div className="flex flex-col gap-8">
        <Section title="Button">
          <Row>
            <Button variant="primary">บันทึกและเรนเดอร์</Button>
            <Button variant="secondary">ยกเลิก</Button>
            <Button variant="ghost">ดูรายละเอียด</Button>
            <Button variant="danger" icon={<Trash2 size={16} />}>
              ลบโปรเจกต์นี้
            </Button>
          </Row>
          <Row>
            <Button variant="primary" disabled disabledReason="เหลืออีก 2 ประโยคจึงเรนเดอร์ได้">
              เรนเดอร์
            </Button>
            <Button variant="secondary" disabled disabledReason="ยังไม่มีคลิปให้ส่งออก">
              ส่งออก
            </Button>
            <Button variant="primary" loading>
              กำลังเริ่มงาน…
            </Button>
            <Button variant="secondary" icon={<Sparkles size={16} />}>
              ให้ AI แก้ให้
            </Button>
            <Button
              variant="secondary"
              iconOnly
              aria-label="ดาวน์โหลด"
              icon={<Download size={16} />}
            />
          </Row>
        </Section>

        <Section title="Chip / segmented">
          <Row>
            <Chip selected>30 วิ</Chip>
            <Chip>60 วิ</Chip>
            <Chip disabled disabledReason="เลือกเพลงก่อน">
              ตัดตามจังหวะ
            </Chip>
            <Chip dense selected>
              TikTok
            </Chip>
            <Chip dense>Reels</Chip>
          </Row>
        </Section>

        <Section title="Tabs">
          <Tabs
            items={[
              { key: 'credit', label: 'โควตา' },
              { key: 'storage', label: 'ที่เก็บข้อมูล' },
              { key: 'defaults', label: 'ค่าเริ่มต้น' },
              { key: 'account', label: 'บัญชี', disabled: true, disabledReason: 'ล็อกอินก่อน' }
            ]}
            activeKey={tab}
            onChange={setTab}
          />
        </Section>

        <Section title="Switch / Checkbox">
          <Row>
            <Switch
              checked={switchOn}
              onChange={setSwitchOn}
              label="ตัดตามจังหวะ — เปิด"
              id="sw-1"
            />
            <Switch checked={false} onChange={() => {}} label="ปิด" id="sw-2" />
            <Switch
              checked={false}
              onChange={() => {}}
              label="เลือกเพลงก่อน"
              id="sw-3"
              disabled
              disabledReason="เลือกเพลงก่อน"
            />
          </Row>
          <Row>
            <Checkbox checked={checked} onChange={setChecked} label="เลือกไว้" id="cb-1" />
            <Checkbox checked={false} onChange={() => {}} label="ยังไม่เลือก" id="cb-2" />
          </Row>
        </Section>

        <Section title="Input / Textarea / Select">
          <Input label="อีเมล" placeholder="noey@cipher.co.th" className="w-64" />
          <Input label="รหัสผ่าน" type="password" error="รหัสผ่านไม่ถูกต้อง" className="w-64" />
          <Input
            label="ชื่อสไตล์"
            disabled
            disabledReason="กำลังบันทึก"
            className="w-64"
            defaultValue="รีวิวสายรัว"
          />
          <Textarea
            label="เล่าให้ AI ฟังสั้น ๆ"
            placeholder="เช่น รีวิวลิปทินท์"
            className="w-72"
          />
          {/* A field with a control INSIDE its border (the login password's
              reveal toggle). Listed here because the focus ring has to be
              composed by hand for that shape — see LoginPage. */}
          <div className="w-64">
            <label htmlFor="dev-composed" className="mb-1.5 block text-sm text-muted">
              ช่องที่มีปุ่มอยู่ในกรอบ
            </label>
            <div className="flex h-10 w-full items-center rounded-md border border-border bg-transparent pr-1 pl-3 transition-colors duration-state ease-out focus-within:outline-2 focus-within:outline-offset-2 focus-within:outline-[color:var(--color-accent)]">
              <input
                id="dev-composed"
                type="password"
                defaultValue="password"
                data-focus-ring="none"
                className="min-w-0 flex-1 bg-transparent text-[15px] text-ink outline-none"
              />
              <button type="button" className="rounded p-1.5 text-muted hover:text-ink">
                <Eye size={17} />
              </button>
            </div>
          </div>
          <Select
            label="ทำไปลงที่ไหน"
            className="w-48"
            value={platform}
            onValueChange={setPlatform}
            options={[
              { value: 'tiktok', label: 'TikTok' },
              { value: 'reels', label: 'Reels' }
            ]}
          />
        </Section>

        <Section title="Slider">
          <Slider
            value={slider}
            min={12}
            max={40}
            onChange={setSlider}
            formatValue={(v) => `${v}px`}
            label="ขนาด"
            id="slider-1"
            className="w-64"
          />
          {/* The timeline's zoom control: narrow, a wide value label, and a
              button immediately after it — the shape where the label used to
              overflow the slider's own box and land on the button. */}
          <div className="flex items-center gap-2">
            <Slider
              className="w-44"
              value={slider}
              min={12}
              max={40}
              onChange={setSlider}
              formatValue={(v) => `${Math.round(v)} px/วิ`}
            />
            <Button icon={<Maximize2 size={14} />}>พอดีจอ</Button>
          </div>
        </Section>

        <Section title="StatusLine">
          <Row>
            {(['ok', 'working', 'error', 'idle'] as Status[]).map((s) => (
              <StatusLine
                key={s}
                status={s}
                label={
                  { ok: 'คลิปพร้อมใช้', working: 'กำลังทำงาน', error: 'ล้มเหลว', idle: 'รอคิว' }[s]
                }
              />
            ))}
          </Row>
        </Section>

        <Section title="Progress">
          <Progress
            steps={['นำเข้า', 'วิเคราะห์เสียงพูด', 'ตัดต่อ', 'เรนเดอร์']}
            currentIndex={1}
            percent={46}
            etaMinutes={3}
            className="w-full max-w-md"
          />
        </Section>

        <Section title="Skeleton">
          <div className="flex w-56 flex-col gap-2">
            <Skeleton variant="media" className="h-32 w-full" />
            <Skeleton variant="text" index={0} className="h-3 w-4/5" />
            <Skeleton variant="text" index={1} className="h-3 w-3/5" />
          </div>
        </Section>

        <Section title="Menu">
          <div className="relative">
            <Button variant="secondary" onClick={() => setMenuOpen((v) => !v)}>
              เปิดเมนู
            </Button>
            {menuOpen ? (
              <div className="absolute left-0 top-11">
                <Menu
                  items={[
                    { key: 'rename', label: 'เปลี่ยนชื่อ' },
                    { key: 'export', label: 'ส่งออกวิดีโอ' },
                    { divider: true },
                    { key: 'delete', label: 'ลบโปรเจกต์นี้', destructive: true }
                  ]}
                  onSelect={() => setMenuOpen(false)}
                />
              </div>
            ) : null}
          </div>
        </Section>

        <Section title="Tooltip">
          <Tooltip content="เล่น / หยุด" shortcutKey="Space">
            <Button variant="ghost" iconOnly aria-label="เล่น" icon={<Mic size={16} />} />
          </Tooltip>
        </Section>

        {/* Composed states that need an app condition to reach — previewed here
            so they can be checked without emptying the real project registry. */}
        <Section title="First-run empty state (ProjectsPage with no projects)">
          <div className="flex h-[420px] w-full flex-col">
            <FirstRunPanel />
          </div>
        </Section>

        {/* Sample shares, so the settings breakdown can be checked without a
            backend that already reports `by_task`. */}
        <Section title="Usage by task (settings → เครดิตและการใช้งาน)">
          <div className="w-full max-w-[560px]">
            <TaskBreakdown
              tasks={[
                { task: 'cut', total_tokens: 510_000, pct: 51 },
                { task: 'effects', total_tokens: 270_000, pct: 27 },
                { task: 'style', total_tokens: 160_000, pct: 16 },
                { task: 'other', total_tokens: 60_000, pct: 6 }
              ]}
            />
          </div>
        </Section>

        <Section title="Dialog / Toast">
          <Row>
            <Button variant="secondary" onClick={() => setDialogOpen(true)}>
              เปิด Dialog
            </Button>
            <Button variant="secondary" onClick={() => setToastOpen(true)}>
              โชว์ Toast
            </Button>
          </Row>
          <Dialog
            open={dialogOpen}
            onClose={() => setDialogOpen(false)}
            title='ลบ "unbox_ลิปทินท์" ?'
            subtitle="ลบแล้วกู้คืนไม่ได้หลังหมดเวลาเลิกทำ"
            width={560}
            onConfirm={() => setDialogOpen(false)}
            footerActions={
              <>
                <Button variant="ghost" onClick={() => setDialogOpen(false)}>
                  ยกเลิก
                </Button>
                <Button variant="danger" onClick={() => setDialogOpen(false)}>
                  ลบโปรเจกต์
                </Button>
              </>
            }
          >
            <p className="text-[15px] leading-[1.7] text-ink-3">
              จะลบคลิปที่ตัดเสร็จ, สคริปต์, เอฟเฟกต์ที่ใส่ไว้ และไฟล์ต้นฉบับ 3
              ไฟล์ในโฟลเดอร์โปรเจกต์
            </p>
          </Dialog>
          {toastOpen ? (
            <Toast
              text="หยุดงาน live_เซรั่ม_take2 แล้ว"
              actionLabel="เลิกทำ"
              onAction={() => setToastOpen(false)}
              onDismiss={() => setToastOpen(false)}
              showCountdown
            />
          ) : null}
        </Section>
      </div>
    </div>
  )
}
