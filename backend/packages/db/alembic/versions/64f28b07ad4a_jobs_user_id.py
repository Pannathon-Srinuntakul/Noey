"""jobs user_id

Revision ID: 64f28b07ad4a
Revises: e05badc0b272
Create Date: 2026-09-27 04:21:10.735462

Whose job a ``core.jobs`` row is. ``GET /jobs/{id}`` used to authorise by
tenant alone, and every account shares tenant ``default`` — so any signed-in
user could read any other user's job, whose ``result`` for a re-edit carries
the whole edit script with its voiceover text. The ids are derived from the
project uid (``vlocal_<uid[:8]>``), not random, so guessing is cheap.

Nullable, no backfill: rows from before this revision and the worker's own
housekeeping jobs have no owner, and the endpoint keeps them tenant-scoped
only. ``ON DELETE SET NULL`` rather than CASCADE — a job row outliving its
user is harmless, and the account-deletion path already removes what matters.

Autogenerate produced far more than this — run with the tenant search_path it
proposed recreating `video_projects` and `effect_styles` wholesale plus the
`core` tables and `alembic_version`. All of that is drift and was removed by
hand, exactly as revisions daa132a95835 and e05badc0b272 record; only the
column, its index and its foreign key remain.
"""
from collections.abc import Sequence
from typing import Union

import sqlalchemy as sa
from alembic import op

# revision identifiers, used by Alembic.
revision: str = '64f28b07ad4a'
down_revision: Union[str, Sequence[str], None] = 'e05badc0b272'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column('jobs', sa.Column('user_id', sa.BigInteger(), nullable=True), schema='core')
    op.create_index(op.f('ix_core_jobs_user_id'), 'jobs', ['user_id'], unique=False, schema='core')
    op.create_foreign_key(
        op.f('fk_jobs_user_id_users'), 'jobs', 'users', ['user_id'], ['id'],
        source_schema='core', referent_schema='core', ondelete='SET NULL',
    )


def downgrade() -> None:
    op.drop_constraint(op.f('fk_jobs_user_id_users'), 'jobs', schema='core', type_='foreignkey')
    op.drop_index(op.f('ix_core_jobs_user_id'), table_name='jobs', schema='core')
    op.drop_column('jobs', 'user_id', schema='core')
