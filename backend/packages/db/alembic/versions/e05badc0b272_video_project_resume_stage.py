"""video project resume stage + resume_state

Revision ID: e05badc0b272
Revises: ce0c8c1ea951
Create Date: 2026-09-26 03:45:37.255146

Where a paused run stopped, on the SERVER. ``stage`` is the furthest pipeline
boundary the project completed (packages/db/models/video_project.py:
PIPELINE_STAGES); ``resume_state`` is the ticket for the boundary currently
being attempted — the worker task + kwargs that would redo it, the estimate
kind that prices the remainder, and, once it pauses, which window ran out and
when it rolls. Both nullable: a project from before this revision has neither,
and POST /videos/{uid}/resume then infers the boundary from the artifacts the
server already holds (edit_script.json / timeline.json / the proxy manifest).

No server_default on ``stage``: "never reported a stage" and "at the first
stage" are different facts, and only the first may follow a later change of
what the first stage is.

Autogenerate produced far more than this — run with the tenant search_path it
proposed recreating `video_projects` and `effect_styles` wholesale plus the
`core` tables and `alembic_version`. All of that is drift and was removed by
hand, exactly as revision daa132a95835 records; only the two intended ADD
COLUMNs remain.
"""
from collections.abc import Sequence
from typing import Union

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

# revision identifiers, used by Alembic.
revision: str = 'e05badc0b272'
down_revision: Union[str, Sequence[str], None] = 'ce0c8c1ea951'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None

SCHEMA = 'tenant_default'


def upgrade() -> None:
    op.add_column(
        'video_projects',
        sa.Column('stage', sa.String(24), nullable=True),
        schema=SCHEMA,
    )
    op.add_column(
        'video_projects',
        sa.Column('resume_state', postgresql.JSONB(astext_type=sa.Text()), nullable=True),
        schema=SCHEMA,
    )


def downgrade() -> None:
    op.drop_column('video_projects', 'resume_state', schema=SCHEMA)
    op.drop_column('video_projects', 'stage', schema=SCHEMA)
