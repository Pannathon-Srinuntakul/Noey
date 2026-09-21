"use client";

import { SearchParam } from "./forms/SearchParam";

/**
 * Stripe Checkout's back/cancel link returns to /pricing?checkout=canceled
 * (the backend sets that URL). Nothing was charged: say so calmly. Renders
 * nothing on the static page itself, so only that return visit gets the box.
 */
export function CheckoutCanceledNotice() {
  return (
    <SearchParam
      name="checkout"
      render={(value) =>
        value === "canceled" ? (
          <div className="notice" role="status" style={{ margin: "0 0 28px" }}>
            <p>ยกเลิกการชำระเงินแล้ว ยังไม่มีการเรียกเก็บเงิน แพลนเดิมของคุณใช้ได้ตามปกติ กลับมาเลือกแพลนได้ทุกเมื่อ</p>
          </div>
        ) : null
      }
    />
  );
}
