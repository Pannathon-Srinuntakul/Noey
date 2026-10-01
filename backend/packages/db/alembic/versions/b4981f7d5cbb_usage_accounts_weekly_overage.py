"""usage_accounts: the weekly window's carried overage (owner, 2026-10-01).

Pro, Studio, Agency and Max now enforce a ``weekly`` window (40 % of the
monthly budget) beside ``monthly``. One call in flight can push BOTH past
100 % at once, by different amounts, and each excess carries into its own
window's next period — so the weekly one needs a column of its own;
``overage_tokens`` / ``overage_window`` stay the plan's main window.
See packages/billing/runs.py.

Generated with ``alembic revision --autogenerate`` against a scratch database
at ``1ec5322f9851``. The autogenerate also proposed creating/dropping the
per-tenant ``effect_styles`` / ``video_projects`` tables and ``alembic_version``
— schema-per-tenant drift the comparison always reports, unrelated to this
change — and those operations were removed.

Revision ID: b4981f7d5cbb
Revises: 1ec5322f9851
Create Date: 2026-10-01 20:52:58.269080

"""
from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

# revision identifiers, used by Alembic.
revision: str = 'b4981f7d5cbb'
down_revision: str | Sequence[str] | None = '1ec5322f9851'
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    """Upgrade schema."""
    op.add_column(
        'usage_accounts',
        sa.Column('weekly_overage_tokens', sa.BigInteger(), server_default='0', nullable=False),
        schema='core',
    )


def downgrade() -> None:
    """Downgrade schema."""
    op.drop_column('usage_accounts', 'weekly_overage_tokens', schema='core')
