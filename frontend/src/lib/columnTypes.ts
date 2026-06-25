import {
  Calculator,
  Calendar,
  CalendarClock,
  CheckSquare,
  CircleDot,
  Hash,
  ToggleLeft,
  Type,
} from 'lucide-react'
import type { LucideIcon } from 'lucide-react'
import type { ColumnUiType } from '../types'

export const COLUMN_TYPE_LABELS: Record<
  ColumnUiType,
  { label: string; Icon: LucideIcon; description: string }
> = {
  text:         { label: 'ข้อความ',          Icon: Type,         description: 'ตัวอักษร ภาษาไทย/อังกฤษ' },
  number:       { label: 'ตัวเลข',           Icon: Hash,         description: 'ตัวเลขทศนิยมหรือจำนวนเต็ม' },
  date:         { label: 'วันที่',            Icon: Calendar,     description: 'วัน เดือน ปี' },
  datetime:     { label: 'วันที่และเวลา',     Icon: CalendarClock, description: 'วัน เดือน ปี พร้อมเวลา' },
  select:       { label: 'ตัวเลือกเดียว',    Icon: CircleDot,    description: 'เลือกได้ 1 ตัวเลือกจากรายการ' },
  multi_select: { label: 'ตัวเลือกหลายอัน', Icon: CheckSquare,  description: 'เลือกได้หลายตัวเลือก' },
  boolean:      { label: 'ใช่/ไม่ใช่',       Icon: ToggleLeft,   description: 'ช่องติ๊กถูก' },
  formula:      { label: 'สูตรคำนวณ',        Icon: Calculator,   description: 'คำนวณอัตโนมัติจากคอลัมน์อื่น' },
}

export const SELECTABLE_TYPES: ColumnUiType[] = [
  'text', 'number', 'date', 'datetime', 'select', 'multi_select', 'boolean', 'formula',
]

export const FORMULA_KINDS: { id: string; label: string; icon: string }[] = [
  { id: 'math',       label: 'คณิตศาสตร์',        icon: '±' },
  { id: 'aggregate',  label: 'สรุปหลายคอลัมน์',   icon: 'Σ' },
  { id: 'percentage', label: 'เปอร์เซ็นต์',       icon: '%' },
  { id: 'date',       label: 'วันที่',              icon: '📅' },
]

export const FORMULA_OPS: Record<string, { id: string; label: string; operandsLabel: [string, string?]; minOps: number; maxOps: number }[]> = {
  math: [
    { id: '+', label: 'บวก (+)',         operandsLabel: ['คอลัมน์/ค่า'], minOps: 2, maxOps: 99 },
    { id: '-', label: 'ลบ (−)',          operandsLabel: ['คอลัมน์/ค่า'], minOps: 2, maxOps: 99 },
    { id: '*', label: 'คูณ (×)',         operandsLabel: ['คอลัมน์/ค่า'], minOps: 2, maxOps: 99 },
    { id: '/', label: 'หาร (÷)',         operandsLabel: ['คอลัมน์/ค่า'], minOps: 2, maxOps: 99 },
    { id: 'MOD', label: 'เศษเหลือ (MOD)', operandsLabel: ['คอลัมน์/ค่า'], minOps: 2, maxOps: 2 },
  ],
  aggregate: [
    { id: 'SUM',   label: 'รวม (SUM)',      operandsLabel: ['คอลัมน์ตัวเลข'], minOps: 2, maxOps: 99 },
    { id: 'AVG',   label: 'เฉลี่ย (AVG)',   operandsLabel: ['คอลัมน์ตัวเลข'], minOps: 2, maxOps: 99 },
    { id: 'MIN',   label: 'น้อยสุด (MIN)',  operandsLabel: ['คอลัมน์ตัวเลข'], minOps: 2, maxOps: 99 },
    { id: 'MAX',   label: 'มากสุด (MAX)',   operandsLabel: ['คอลัมน์ตัวเลข'], minOps: 2, maxOps: 99 },
    { id: 'COUNT', label: 'นับค่า (COUNT)', operandsLabel: ['คอลัมน์'],        minOps: 2, maxOps: 99 },
  ],
  percentage: [
    { id: 'pct',    label: 'เปอร์เซ็นต์ (a/b×100)', operandsLabel: ['ตัวตั้ง (a)', 'ฐาน (b)'], minOps: 2, maxOps: 2 },
    { id: 'growth', label: 'อัตราเติบโต ((ใหม่-เก่า)/เก่า×100)', operandsLabel: ['ค่าใหม่', 'ค่าเก่า'], minOps: 2, maxOps: 2 },
  ],
  date: [
    { id: 'date_diff',       label: 'ผลต่างวันที่ (→วัน)',    operandsLabel: ['วันที่ตั้ง', 'วันที่ลบ'], minOps: 2, maxOps: 2 },
    { id: 'date_add_days',   label: 'บวกวัน (date + n วัน)',   operandsLabel: ['คอลัมน์วันที่', 'จำนวนวัน'], minOps: 2, maxOps: 2 },
    { id: 'date_add_months', label: 'บวกเดือน',                operandsLabel: ['คอลัมน์วันที่', 'จำนวนเดือน'], minOps: 2, maxOps: 2 },
    { id: 'date_add_years',  label: 'บวกปี',                   operandsLabel: ['คอลัมน์วันที่', 'จำนวนปี'], minOps: 2, maxOps: 2 },
  ],
}

// Legacy (Phase-1) ops — kept for backward compat display
export const LEGACY_FORMULA_OPS: Record<string, string> = {
  date_add:  'วันที่ + จำนวนวัน',
  date_diff: 'ผลต่างระหว่างวันที่',
}
