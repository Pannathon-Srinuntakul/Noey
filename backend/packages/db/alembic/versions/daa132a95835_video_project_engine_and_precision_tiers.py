"""video project engine and precision tiers

Revision ID: daa132a95835
Revises: 5acb26fefac3
Create Date: 2026-09-07 20:54:59.990227

Two nullable columns holding the user's chosen AI quality tiers (see
packages/video/quality.py). NULL = the project predates the feature and runs on
the defaults, which is why neither column has a server_default: "never chose"
and "chose the default" are different facts, and only the first should silently
follow a future change of default.

Autogenerate produced far more than this — it ran with the tenant search_path
and therefore proposed dropping the whole `core` schema (users, tenants, jobs,
memberships, usage logs) plus unrelated FK/type churn and a `cut_mode` column
that is drift from an older revision. All of that was removed by hand; only the
two intended ADD COLUMNs remain.
"""
from collections.abc import Sequence
from typing import Union

import sqlalchemy as sa
from alembic import op

# revision identifiers, used by Alembic.
revision: str = 'daa132a95835'
down_revision: Union[str, Sequence[str], None] = '5acb26fefac3'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None

SCHEMA = 'tenant_default'


def upgrade() -> None:
    op.add_column(
        'video_projects',
        sa.Column('engine', sa.String(16), nullable=True),
        schema=SCHEMA,
    )
    op.add_column(
        'video_projects',
        sa.Column('precision', sa.String(16), nullable=True),
        schema=SCHEMA,
    )


def downgrade() -> None:
    op.drop_column('video_projects', 'precision', schema=SCHEMA)
    op.drop_column('video_projects', 'engine', schema=SCHEMA)
