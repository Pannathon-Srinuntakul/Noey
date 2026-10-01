"""usage_accounts: the carried overage (owner, 2026-10-01).

A call already in flight when the plan's window reaches 100 % is charged in
full, so a window can end above 100 %. ``overage_tokens`` is that excess and
``overage_window`` the window it was charged past; the next period of that
window starts AT the overage instead of 0 (106 % → 6 %), and Free's overage
(``lifetime`` never resets) is applied to the first paid window after an
upgrade. See packages/billing/runs.py.

Generated with ``alembic revision --autogenerate`` against a scratch database
at ``df3fde09f064``. The autogenerate also proposed creating/dropping the
per-tenant ``effect_styles`` / ``video_projects`` tables and ``alembic_version``
— schema-per-tenant drift the comparison always reports, unrelated to this
change — and those operations were removed.

Revision ID: 1ec5322f9851
Revises: df3fde09f064
Create Date: 2026-10-01 19:21:12.051538

"""
from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

# revision identifiers, used by Alembic.
revision: str = '1ec5322f9851'
down_revision: str | Sequence[str] | None = 'df3fde09f064'
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    """Upgrade schema."""
    op.add_column('usage_accounts', sa.Column('overage_tokens', sa.BigInteger(), server_default='0', nullable=False), schema='core')
    op.add_column('usage_accounts', sa.Column('overage_window', sa.String(length=16), nullable=True), schema='core')


def downgrade() -> None:
    """Downgrade schema."""
    op.drop_column('usage_accounts', 'overage_window', schema='core')
    op.drop_column('usage_accounts', 'overage_tokens', schema='core')
