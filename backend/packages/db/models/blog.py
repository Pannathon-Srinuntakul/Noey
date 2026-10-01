"""The website blog (core schema — the blog belongs to the site, not to a tenant).

Posts are written either by an AI client through the blog MCP server
(services/mcp/, ``source = "ai"``) or edited by the owner in the admin
dashboard (``source = "human"``). The public read API is
services/api/routers/blog.py; the shape it returns is fixed by
BLOG_CONTRACT.md at the repo root.

Rules the schema carries:

- ``slug`` is unique and LOCKED once ``published_at`` is set (the first
  publish): a URL search engines indexed must never move.
- Categories are a fixed, seeded set — an AI client cannot create one; tags
  are free-form and created on first use (normalised to a slug).
- Every write, from MCP or from the admin, appends a ``blog_audit_log`` row.

The OAuth tables back the MCP server's authorization server (packages/blog/
oauth.py): a client registers itself (DCR), the owner approves it in the admin
dashboard, and every token it holds hangs off one ``blog_oauth_grants`` row —
revoking that row ends access at once.
"""

from datetime import datetime

from sqlalchemy import (
    BigInteger,
    Boolean,
    CheckConstraint,
    DateTime,
    ForeignKey,
    Index,
    Integer,
    String,
    Text,
    func,
)
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.orm import Mapped, mapped_column

from packages.db.base import Base
from packages.db.models.core_auth import CORE_SCHEMA

POST_STATUSES = ("draft", "published", "unpublished")
POST_SOURCES = ("ai", "human")
DEFAULT_AUTHOR = "Noey Studio"


class BlogCategory(Base):
    """A fixed category (seeded by migration; never created by an AI client)."""

    __tablename__ = "blog_categories"
    __table_args__ = ({"schema": CORE_SCHEMA},)

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    slug: Mapped[str] = mapped_column(String(80), unique=True)
    name: Mapped[str] = mapped_column(String(80))
    description: Mapped[str] = mapped_column(String(300), default="", server_default="")
    sort_order: Mapped[int] = mapped_column(Integer, default=0, server_default="0")
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())


class BlogTag(Base):
    __tablename__ = "blog_tags"
    __table_args__ = ({"schema": CORE_SCHEMA},)

    id: Mapped[int] = mapped_column(BigInteger, primary_key=True, autoincrement=True)
    #: a-z0-9- (packages/blog/validation.py:slugify_tag).
    slug: Mapped[str] = mapped_column(String(80), unique=True)
    #: As the writer spelled it (Thai is fine): "ซับไทย".
    name: Mapped[str] = mapped_column(String(80))
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())


class BlogPost(Base):
    __tablename__ = "blog_posts"
    __table_args__ = (
        CheckConstraint("status IN ('draft', 'published', 'unpublished')", name="status"),
        CheckConstraint("source IN ('ai', 'human')", name="source"),
        Index("ix_blog_posts_status_published_at", "status", "published_at"),
        {"schema": CORE_SCHEMA},
    )

    id: Mapped[int] = mapped_column(BigInteger, primary_key=True, autoincrement=True)
    #: a-z0-9-, <= 80 chars. Immutable once published_at is set.
    slug: Mapped[str] = mapped_column(String(80), unique=True)
    title: Mapped[str] = mapped_column(String(200))
    meta_title: Mapped[str] = mapped_column(String(60))
    meta_description: Mapped[str] = mapped_column(String(160))
    excerpt: Mapped[str] = mapped_column(String(300))
    #: GitHub-flavoured Markdown, headings from ##, no raw HTML.
    content_md: Mapped[str] = mapped_column(Text)
    cover_image_url: Mapped[str | None] = mapped_column(String(500), nullable=True)
    cover_alt: Mapped[str | None] = mapped_column(String(300), nullable=True)
    cover_width: Mapped[int | None] = mapped_column(Integer, nullable=True)
    cover_height: Mapped[int | None] = mapped_column(Integer, nullable=True)
    category_id: Mapped[int] = mapped_column(
        Integer, ForeignKey(f"{CORE_SCHEMA}.blog_categories.id", ondelete="RESTRICT"), index=True
    )
    #: [{"question": str, "answer": str}] — plain text answers.
    faq: Mapped[list] = mapped_column(JSONB, default=list, server_default="[]")
    status: Mapped[str] = mapped_column(String(16), default="draft", server_default="draft")
    author: Mapped[str] = mapped_column(String(80), default=DEFAULT_AUTHOR, server_default=DEFAULT_AUTHOR)
    #: "ai" = written through MCP and still editable there; "human" = the owner
    #: wrote or edited it in the admin, and MCP may no longer change it.
    source: Mapped[str] = mapped_column(String(8), default="ai", server_default="ai")
    #: `mcp:<client_id>` or `admin:<user_id>`.
    created_by: Mapped[str] = mapped_column(String(120))
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())
    #: Set by the FIRST publish and kept through unpublish/re-publish.
    published_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), onupdate=func.now()
    )


class BlogPostTag(Base):
    __tablename__ = "blog_post_tags"
    __table_args__ = ({"schema": CORE_SCHEMA},)

    post_id: Mapped[int] = mapped_column(
        BigInteger, ForeignKey(f"{CORE_SCHEMA}.blog_posts.id", ondelete="CASCADE"), primary_key=True
    )
    tag_id: Mapped[int] = mapped_column(
        BigInteger, ForeignKey(f"{CORE_SCHEMA}.blog_tags.id", ondelete="CASCADE"), primary_key=True, index=True
    )


class BlogImage(Base):
    """An uploaded image, already re-encoded to WebP (metadata stripped)."""

    __tablename__ = "blog_images"
    __table_args__ = ({"schema": CORE_SCHEMA},)

    id: Mapped[int] = mapped_column(BigInteger, primary_key=True, autoincrement=True)
    url: Mapped[str] = mapped_column(String(500))
    #: Object key: `blog/<sha256 of the encoded file>.webp` — content-addressed.
    key: Mapped[str] = mapped_column(String(300), unique=True)
    mime: Mapped[str] = mapped_column(String(40))
    bytes: Mapped[int] = mapped_column(Integer)
    width: Mapped[int] = mapped_column(Integer)
    height: Mapped[int] = mapped_column(Integer)
    alt: Mapped[str] = mapped_column(String(300))
    uploaded_by: Mapped[str] = mapped_column(String(120))
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())


class BlogAuditLog(Base):
    """Append-only: every blog write through MCP or the admin, allowed or refused."""

    __tablename__ = "blog_audit_log"
    __table_args__ = (
        Index("ix_blog_audit_log_at", "at"),
        {"schema": CORE_SCHEMA},
    )

    id: Mapped[int] = mapped_column(BigInteger, primary_key=True, autoincrement=True)
    at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())
    #: `mcp:<client_id>` / `admin:<user_id>` / `oauth` for authorization steps.
    actor: Mapped[str] = mapped_column(String(120))
    #: The MCP tool name or the admin action (`admin_update`, `oauth_approve`, …).
    action: Mapped[str] = mapped_column(String(40))
    slug: Mapped[str | None] = mapped_column(String(80), nullable=True)
    ok: Mapped[bool] = mapped_column(Boolean)
    #: Arguments (content trimmed), the refusal reason, before/after. Never a
    #: token or a secret.
    detail: Mapped[dict | None] = mapped_column(JSONB, nullable=True)


# ── OAuth 2.1 for the blog MCP server ────────────────────────────────────────


class BlogOAuthClient(Base):
    """A dynamically registered OAuth client (RFC 7591), e.g. one claude.ai connector."""

    __tablename__ = "blog_oauth_clients"
    __table_args__ = ({"schema": CORE_SCHEMA},)

    client_id: Mapped[str] = mapped_column(String(64), primary_key=True)
    client_name: Mapped[str | None] = mapped_column(String(200), nullable=True)
    #: The registered client metadata as the SDK models it, WITHOUT the secret.
    info: Mapped[dict] = mapped_column(JSONB)
    #: The client secret, encrypted (packages/blog/oauth.py) — NULL for a
    #: public client (token_endpoint_auth_method "none").
    secret_enc: Mapped[str | None] = mapped_column(Text, nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())
    revoked_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)


class BlogOAuthRequest(Base):
    """One /authorize request, waiting for the owner's consent in the admin.

    Approving it mints the authorization code on the same row (stored hashed,
    single use, 5 minutes).
    """

    __tablename__ = "blog_oauth_requests"
    __table_args__ = ({"schema": CORE_SCHEMA},)

    #: Random, URL-safe; the admin consent page is /connect?request=<id>.
    id: Mapped[str] = mapped_column(String(64), primary_key=True)
    client_id: Mapped[str] = mapped_column(
        String(64), ForeignKey(f"{CORE_SCHEMA}.blog_oauth_clients.client_id", ondelete="CASCADE"), index=True
    )
    #: state, scopes, code_challenge, redirect_uri, redirect_uri_provided_explicitly, resource.
    params: Mapped[dict] = mapped_column(JSONB)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())
    expires_at: Mapped[datetime] = mapped_column(DateTime(timezone=True))
    #: approved | denied — NULL while waiting.
    decision: Mapped[str | None] = mapped_column(String(16), nullable=True)
    decided_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    admin_user_id: Mapped[int | None] = mapped_column(
        BigInteger, ForeignKey(f"{CORE_SCHEMA}.users.id", ondelete="CASCADE"), nullable=True
    )
    #: SHA-256 of the authorization code, hex.
    code_hash: Mapped[str | None] = mapped_column(String(64), unique=True, nullable=True)
    code_expires_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    code_used_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    grant_id: Mapped[int | None] = mapped_column(
        BigInteger, ForeignKey(f"{CORE_SCHEMA}.blog_oauth_grants.id", ondelete="CASCADE"), nullable=True
    )


class BlogOAuthGrant(Base):
    """What the owner approved: one client acting for one admin. Tokens hang off it."""

    __tablename__ = "blog_oauth_grants"
    __table_args__ = ({"schema": CORE_SCHEMA},)

    id: Mapped[int] = mapped_column(BigInteger, primary_key=True, autoincrement=True)
    client_id: Mapped[str] = mapped_column(
        String(64), ForeignKey(f"{CORE_SCHEMA}.blog_oauth_clients.client_id", ondelete="CASCADE"), index=True
    )
    admin_user_id: Mapped[int] = mapped_column(
        BigInteger, ForeignKey(f"{CORE_SCHEMA}.users.id", ondelete="CASCADE"), index=True
    )
    #: users.token_version at approval: a password change/reset ends the grant.
    token_version: Mapped[int] = mapped_column(Integer)
    scopes: Mapped[str] = mapped_column(String(200))
    #: The RFC 8707 resource the tokens are bound to (the MCP endpoint URL).
    resource: Mapped[str] = mapped_column(String(300))
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())
    last_used_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    revoked_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    #: Why: admin_revoke | refresh_reuse | admin_inactive.
    revoked_reason: Mapped[str | None] = mapped_column(String(40), nullable=True)
