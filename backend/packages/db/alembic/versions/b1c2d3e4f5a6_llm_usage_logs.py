"""Add LLM usage tracking: plan/usage_reset_at on users, core.llm_usage_logs table.

Revision ID: b1c2d3e4f5a6
Revises: a5b6c7d8e9f0
Create Date: 2026-06-25
"""

from alembic import op
import sqlalchemy as sa

revision = "b1c2d3e4f5a6"
down_revision = "a5b6c7d8e9f0"
branch_labels = None
depends_on = None


def upgrade() -> None:
    # Add plan tier and manual reset point to core.users
    op.add_column(
        "users",
        sa.Column("plan", sa.String(32), nullable=False, server_default="free"),
        schema="core",
    )
    op.add_column(
        "users",
        sa.Column("usage_reset_at", sa.DateTime(timezone=True), nullable=True),
        schema="core",
    )

    # Token usage audit log in core schema (not per-tenant — spans all features)
    op.create_table(
        "llm_usage_logs",
        sa.Column("id", sa.BigInteger(), autoincrement=True, nullable=False),
        sa.Column("user_id", sa.BigInteger(), nullable=False),
        sa.Column("tenant_id", sa.BigInteger(), nullable=False),
        sa.Column("feature", sa.String(32), nullable=False),   # chat|video|prompt_cron
        sa.Column("reference_id", sa.String(64), nullable=True),  # session/project/job uid
        sa.Column("model", sa.String(128), nullable=False),
        sa.Column("input_tokens", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("output_tokens", sa.Integer(), nullable=False, server_default="0"),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.ForeignKeyConstraint(
            ["user_id"], ["core.users.id"],
            name="fk_llm_usage_logs_user_id",
            ondelete="CASCADE",
        ),
        sa.ForeignKeyConstraint(
            ["tenant_id"], ["core.tenants.id"],
            name="fk_llm_usage_logs_tenant_id",
            ondelete="CASCADE",
        ),
        sa.PrimaryKeyConstraint("id", name="pk_llm_usage_logs"),
        schema="core",
    )
    op.create_index("ix_llm_usage_logs_user_id", "llm_usage_logs", ["user_id"], schema="core")
    op.create_index("ix_llm_usage_logs_created_at", "llm_usage_logs", ["created_at"], schema="core")
    op.create_index("ix_llm_usage_logs_feature", "llm_usage_logs", ["feature"], schema="core")


def downgrade() -> None:
    op.drop_index("ix_llm_usage_logs_feature", table_name="llm_usage_logs", schema="core")
    op.drop_index("ix_llm_usage_logs_created_at", table_name="llm_usage_logs", schema="core")
    op.drop_index("ix_llm_usage_logs_user_id", table_name="llm_usage_logs", schema="core")
    op.drop_table("llm_usage_logs", schema="core")
    op.drop_column("users", "usage_reset_at", schema="core")
    op.drop_column("users", "plan", schema="core")
