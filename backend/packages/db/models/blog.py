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


MEDIA_KINDS = ("image", "video", "file")
#: Where an asset came from: `upload_image` (MCP, small images), `render_cover`
#: (MCP, a 1600×900 cover drawn server-side), `library` (the owner's media
#: library in the admin) or `brand` (the logo, written by the server itself).
MEDIA_ORIGINS = ("upload", "render_cover", "library", "brand")
#: The owner's media library categories (list_media's `kind`).
LIBRARY_CATEGORIES = ("screenshot", "demo", "logo", "file")


class BlogImage(Base):
    """One stored blog media asset — despite the table name, every kind: an
    image (WebP, re-encoded), a video (H.264 MP4 + a WebP poster) or a file
    (PDF, served as a download). Content-addressed: the same bytes are one row.
    In-article HTML visuals are NOT here — they are `blog_visuals`.

    The table predates video and PDF support; it kept its name so existing
    rows, URLs and the cover lookup stay valid.
    """

    __tablename__ = "blog_images"
    __table_args__ = (
        CheckConstraint("kind IN ('image', 'video', 'file')", name="kind"),
        CheckConstraint(
            "origin IN ('upload', 'render_cover', 'library', 'brand')", name="origin"
        ),
        CheckConstraint(
            "category IS NULL OR category IN ('screenshot', 'demo', 'logo', 'file')", name="category"
        ),
        Index("ix_blog_images_origin_category", "origin", "category"),
        {"schema": CORE_SCHEMA},
    )

    id: Mapped[int] = mapped_column(BigInteger, primary_key=True, autoincrement=True)
    url: Mapped[str] = mapped_column(String(500))
    #: Object key: `blog/<sha256 of the stored file>.<webp|mp4|pdf>` — content-addressed.
    key: Mapped[str] = mapped_column(String(300), unique=True)
    mime: Mapped[str] = mapped_column(String(40))
    bytes: Mapped[int] = mapped_column(Integer)
    #: Pixels of the stored file (images, videos); 0 for a PDF.
    width: Mapped[int] = mapped_column(Integer)
    height: Mapped[int] = mapped_column(Integer)
    alt: Mapped[str] = mapped_column(String(300))
    uploaded_by: Mapped[str] = mapped_column(String(120))
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())
    kind: Mapped[str] = mapped_column(String(16), default="image", server_default="image")
    origin: Mapped[str] = mapped_column(String(24), default="upload", server_default="upload")
    #: Library items only (screenshot | demo | logo | file); NULL otherwise.
    category: Mapped[str | None] = mapped_column(String(16), nullable=True)
    description: Mapped[str] = mapped_column(String(1000), default="", server_default="")
    #: Free-form library tags, lowercased: ["editor", "timeline"].
    tags: Mapped[list] = mapped_column(JSONB, default=list, server_default="[]")
    #: Videos: the first frame as WebP (its own content-addressed object).
    poster_url: Mapped[str | None] = mapped_column(String(500), nullable=True)
    poster_key: Mapped[str | None] = mapped_column(String(300), nullable=True)
    duration_ms: Mapped[int | None] = mapped_column(Integer, nullable=True)
    #: As uploaded or as the writer named it (informational, never a path).
    filename: Mapped[str | None] = mapped_column(String(200), nullable=True)
    #: The owner hid it from list_media. The file stays: posts may use it.
    archived_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)


class BlogVisual(Base):
    """An in-article visual: self-contained HTML/CSS/JS the AI writer made
    with `create_visual`, stored (never rendered on the server) under the
    bucket's `visual/` prefix and served from the cookieless embed origin
    (embed.noeystudio.com/visual/<id>) inside a sandboxed iframe on the site.

    The id is derived from the creator and the stored document, so the bytes
    behind an id never change (served as immutable)."""

    __tablename__ = "blog_visuals"
    __table_args__ = ({"schema": CORE_SCHEMA},)

    #: 32 hex chars: sha256(created_by + document)[:32].
    id: Mapped[str] = mapped_column(String(32), primary_key=True)
    #: `visual/<id>.html`.
    key: Mapped[str] = mapped_column(String(300), unique=True)
    #: The designed canvas size — fixes the aspect ratio on the page.
    width: Mapped[int] = mapped_column(Integer)
    height: Mapped[int] = mapped_column(Integer)
    alt: Mapped[str] = mapped_column(String(300))
    caption: Mapped[str | None] = mapped_column(String(300), nullable=True)
    #: Moves (CSS animation / JS). A post may hold at most 3 of these.
    animated: Mapped[bool] = mapped_column(Boolean, default=False, server_default="false")
    bytes: Mapped[int] = mapped_column(Integer)
    #: `mcp:<client_id>` — a post may only use visuals of its own connection.
    created_by: Mapped[str] = mapped_column(String(120), index=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())


class BlogBrief(Base):
    """The owner's writing brief for the AI writer — one row (id = 1), edited in
    the admin and returned by `get_site_info`."""

    __tablename__ = "blog_brief"
    __table_args__ = (
        CheckConstraint("id = 1", name="single_row"),
        {"schema": CORE_SCHEMA},
    )

    id: Mapped[int] = mapped_column(Integer, primary_key=True, default=1)
    tone: Mapped[str] = mapped_column(String(1000), default="", server_default="")
    focus_topics: Mapped[str] = mapped_column(String(2000), default="", server_default="")
    avoid_topics: Mapped[str] = mapped_column(String(2000), default="", server_default="")
    length: Mapped[str] = mapped_column(String(500), default="", server_default="")
    media: Mapped[str] = mapped_column(String(500), default="", server_default="")
    monthly_note: Mapped[str] = mapped_column(String(2000), default="", server_default="")
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())
    updated_by: Mapped[int | None] = mapped_column(
        BigInteger, ForeignKey(f"{CORE_SCHEMA}.users.id", ondelete="SET NULL"), nullable=True
    )


PLAN_STATUSES = ("planned", "writing", "done", "skipped")


class BlogPlanItem(Base):
    """One topic of the owner's ordered content plan. The AI writer takes the
    first `planned` one; `mark_topic_done` links it to the post it wrote."""

    __tablename__ = "blog_content_plan"
    __table_args__ = (
        CheckConstraint("status IN ('planned', 'writing', 'done', 'skipped')", name="status"),
        Index("ix_blog_content_plan_status_position", "status", "position"),
        {"schema": CORE_SCHEMA},
    )

    id: Mapped[int] = mapped_column(BigInteger, primary_key=True, autoincrement=True)
    #: Order in the plan (ascending); the admin rewrites it on reorder.
    position: Mapped[int] = mapped_column(Integer, default=0, server_default="0")
    topic: Mapped[str] = mapped_column(String(200))
    notes: Mapped[str] = mapped_column(String(1000), default="", server_default="")
    status: Mapped[str] = mapped_column(String(16), default="planned", server_default="planned")
    #: The post that covers it (set by mark_topic_done or the admin). Not a
    #: foreign key on purpose: a slug is what both sides speak, and the post
    #: row is never deleted anyway.
    post_slug: Mapped[str | None] = mapped_column(String(80), nullable=True)
    done_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), onupdate=func.now()
    )


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
