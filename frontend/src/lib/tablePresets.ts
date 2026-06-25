import { FileSpreadsheet, Package } from 'lucide-react'
import type { LucideIcon } from 'lucide-react'
import type { ColumnMetaIn } from '../types'

export interface TablePreset {
  id: string
  name: string
  Icon: LucideIcon
  description: string
  columns: ColumnMetaIn[]
}

/**
 * Built-in templates offered when creating a table. These are OPTIONS — the user picks
 * one; nothing is applied by default. Columns are created in order, so the backend assigns
 * keys col_1..col_N matching the array index + 1. Formula columns therefore reference the
 * sequential keys of earlier columns.
 */
export const TABLE_PRESETS: TablePreset[] = [
  {
    id: 'blank',
    name: 'เริ่มต้นเปล่า',
    Icon: FileSpreadsheet,
    description: 'ตารางว่างเปล่า เพิ่มคอลัมน์เองได้ทั้งหมด',
    columns: [],
  },
  {
    id: 'product-tracking',
    name: 'ติดตามสินค้า (TikTok Affiliate)',
    Icon: Package,
    description:
      'ตามสเปรดชีตสินค้า: ชื่อ หมวดหมู่ คอมมิชชั่น วันที่ + คำนวณวันที่ต้องลงคลิปอัตโนมัติ',
    columns: [
      { label: 'ชื่อสินค้า', ui_type: 'text' }, // col_1
      { label: 'หมวดหมู่', ui_type: 'select', options: ['A', 'B', 'C', 'D'] }, // col_2
      { label: 'แบรนด์', ui_type: 'text' }, // col_3
      { label: 'ประเภทสินค้า', ui_type: 'text' }, // col_4
      { label: 'ค่าคอมมิชชั่น/ชิ้น (บาท)', ui_type: 'number' }, // col_5
      { label: 'คอมมิชชั่นหลังยิงแอด/ชิ้น (บาท)', ui_type: 'number' }, // col_6
      { label: 'วันที่ได้รับสินค้า', ui_type: 'date' }, // col_7
      { label: 'ระยะเวลาการทำงาน (วัน)', ui_type: 'number' }, // col_8
      {
        label: 'วันที่ต้องลงคลิป',
        ui_type: 'formula',
        formula: { type: 'date_add', col_a: 'col_7', col_b: 'col_8' },
      }, // col_9
      { label: 'สินค้าตัวอย่าง', ui_type: 'text' }, // col_10
      { label: 'สถานะ', ui_type: 'select', options: ['ทำแล้ว', 'ยังไม่ได้ทำ'] }, // col_11
      { label: 'หมายเหตุ', ui_type: 'text' }, // col_12
    ],
  },
]
