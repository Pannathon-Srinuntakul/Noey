"""Top-up wallet endpoints — a baht balance, never tokens.

GET  /wallet/me        balance, open holds, lots with expiry, last 30 movements,
                       the packs and payment methods on offer
POST /wallet/checkout  {pack_satang, method} → {url}: a Stripe one-time
                       Checkout (PromptPay or card), or — without Stripe,
                       only with WALLET_MOCK_TOPUP=1 AND the database on
                       loopback — a mock credit and the success URL. 503
                       otherwise without Stripe.

The balance is spent only by runs started with ``allow_wallet`` once the
plan's windows are exhausted (packages/billing/runs.py). See
packages/billing/wallet.py and docs/token-billing-design.md §9.4.
"""

from typing import Annotated, Literal

import stripe
from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlalchemy.ext.asyncio import AsyncSession

from packages.billing import topup, wallet
from packages.billing.client import billing_enabled, get_stripe_client
from services.api.deps import CurrentUser, core_session

router = APIRouter(prefix="/wallet", tags=["wallet"])

CoreSession = Annotated[AsyncSession, Depends(core_session)]


def optional_stripe() -> stripe.StripeClient | None:
    """Overridden in tests."""
    return get_stripe_client() if billing_enabled() else None


OptionalStripe = Annotated[stripe.StripeClient | None, Depends(optional_stripe)]


class CheckoutIn(BaseModel):
    pack_satang: Literal[10_000, 30_000, 50_000, 100_000]
    method: Literal["promptpay", "card"] = "promptpay"


class UrlOut(BaseModel):
    url: str


@router.get("/me")
async def wallet_me(auth: CurrentUser, session: CoreSession) -> dict:
    return await wallet.summary(session, auth.user_id)


@router.post("/checkout", response_model=UrlOut)
async def wallet_checkout(
    body: CheckoutIn, auth: CurrentUser, session: CoreSession, client: OptionalStripe
) -> UrlOut:
    try:
        url = await topup.create_checkout(session, auth.user, body.pack_satang, body.method, client=client)
    except topup.TopupUnavailable:
        raise HTTPException(status_code=503, detail="ยังเติมเงินไม่ได้ในตอนนี้ — ระบบชำระเงินยังไม่พร้อม") from None
    except stripe.StripeError as exc:
        raise HTTPException(status_code=502, detail="เปิดหน้าชำระเงินไม่สำเร็จ กรุณาลองใหม่") from exc
    await session.commit()
    return UrlOut(url=url)
