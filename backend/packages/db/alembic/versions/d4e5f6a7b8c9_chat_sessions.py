"""chat_sessions

Add chat_sessions and chat_messages tables to tenant_default schema.

Revision ID: d4e5f6a7b8c9
Revises: 3f7e8a9b0c1d
Create Date: 2026-06-22

"""
from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

revision: str = 'd4e5f6a7b8c9'
down_revision: Union[str, Sequence[str], None] = '3f7e8a9b0c1d'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.execute("CREATE SCHEMA IF NOT EXISTS tenant_default")

    op.create_table(
        'chat_sessions',
        sa.Column('uid', sa.String(36), nullable=False),
        sa.Column('user_id', sa.BigInteger(), nullable=False),
        sa.Column('title', sa.String(255), nullable=False, server_default='New Chat'),
        sa.Column('summary', sa.Text(), nullable=True),
        sa.Column('message_count', sa.Integer(), nullable=False, server_default='0'),
        sa.Column('created_at', sa.DateTime(timezone=True), server_default=sa.text('now()'), nullable=False),
        sa.Column('updated_at', sa.DateTime(timezone=True), server_default=sa.text('now()'), nullable=False),
        sa.ForeignKeyConstraint(
            ['user_id'], ['core.users.id'],
            name=op.f('fk_chat_sessions_user_id_users'), ondelete='CASCADE',
        ),
        sa.PrimaryKeyConstraint('uid', name=op.f('pk_chat_sessions')),
        schema='tenant_default',
    )
    op.create_index(
        op.f('ix_chat_sessions_user_id'), 'chat_sessions', ['user_id'],
        unique=False, schema='tenant_default',
    )
    op.create_index(
        op.f('ix_chat_sessions_updated_at'), 'chat_sessions', ['updated_at'],
        unique=False, schema='tenant_default',
    )

    op.create_table(
        'chat_messages',
        sa.Column('uid', sa.String(36), nullable=False),
        sa.Column('session_uid', sa.String(36), nullable=False),
        sa.Column('role', sa.String(16), nullable=False),
        sa.Column('content', sa.Text(), nullable=False),
        sa.Column('created_at', sa.DateTime(timezone=True), server_default=sa.text('now()'), nullable=False),
        sa.ForeignKeyConstraint(
            ['session_uid'], ['tenant_default.chat_sessions.uid'],
            name=op.f('fk_chat_messages_session_uid_chat_sessions'), ondelete='CASCADE',
        ),
        sa.PrimaryKeyConstraint('uid', name=op.f('pk_chat_messages')),
        schema='tenant_default',
    )
    op.create_index(
        op.f('ix_chat_messages_session_uid'), 'chat_messages', ['session_uid'],
        unique=False, schema='tenant_default',
    )
    op.create_index(
        op.f('ix_chat_messages_created_at'), 'chat_messages', ['created_at'],
        unique=False, schema='tenant_default',
    )


def downgrade() -> None:
    op.drop_index(op.f('ix_chat_messages_created_at'), table_name='chat_messages', schema='tenant_default')
    op.drop_index(op.f('ix_chat_messages_session_uid'), table_name='chat_messages', schema='tenant_default')
    op.drop_table('chat_messages', schema='tenant_default')
    op.drop_index(op.f('ix_chat_sessions_updated_at'), table_name='chat_sessions', schema='tenant_default')
    op.drop_index(op.f('ix_chat_sessions_user_id'), table_name='chat_sessions', schema='tenant_default')
    op.drop_table('chat_sessions', schema='tenant_default')
