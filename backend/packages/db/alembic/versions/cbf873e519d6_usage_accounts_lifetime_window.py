"""usage_accounts: the lifetime window (Free's one-time trial credit)

Free stopped being a monthly allowance on 2026-09-29 and became a credit the
account gets once: ``PLAN_LIMITS["free"].windows == ("lifetime",)``. The
lifetime window never rolls, so it needs its own pair of columns rather than
reusing ``monthly_*``, which ``runs.roll_windows`` clears every 30 days.

Every plan charges it (``limits.TRACKED_WINDOWS``), not only Free — otherwise
a user could upgrade, come back to Free, and find the trial credit refilled.

Existing rows start at 0: the beta population is small and giving everyone a
fresh credit once is cheaper than a backfill that guesses what they already
spent under the old monthly rules.

Autogenerate also proposed moving the per-tenant tables (``video_projects``,
``effect_styles``) out of ``tenant_default`` and dropping ``alembic_version``.
That is the usual artifact of running autogenerate against a search_path that
has one tenant on it — those tables are created per tenant by
``packages/db/tenancy.py``, not by migrations. Dropped from this file.

Revision ID: cbf873e519d6
Revises: 64f28b07ad4a
Create Date: 2026-09-29 20:50:33.673527

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa

# revision identifiers, used by Alembic.
revision: str = 'cbf873e519d6'
down_revision: Union[str, Sequence[str], None] = '64f28b07ad4a'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    """Upgrade schema."""
    op.add_column(
        'usage_accounts',
        sa.Column('lifetime_started_at', sa.DateTime(timezone=True), nullable=True),
        schema='core',
    )
    op.add_column(
        'usage_accounts',
        sa.Column('lifetime_used', sa.BigInteger(), server_default='0', nullable=False),
        schema='core',
    )


def downgrade() -> None:
    """Downgrade schema."""
    op.drop_column('usage_accounts', 'lifetime_used', schema='core')
    op.drop_column('usage_accounts', 'lifetime_started_at', schema='core')
