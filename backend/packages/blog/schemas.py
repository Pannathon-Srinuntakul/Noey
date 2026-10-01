"""Input models shared by the MCP tools and the admin routes."""

from __future__ import annotations

from typing import Annotated

from pydantic import BaseModel, ConfigDict, Field

from packages.blog import validation as v


class FaqItem(BaseModel):
    model_config = ConfigDict(extra="forbid")

    question: Annotated[str, Field(min_length=1, max_length=v.FAQ_QUESTION_MAX, description="The question, in Thai.")]
    answer: Annotated[
        str, Field(min_length=1, max_length=v.FAQ_ANSWER_MAX, description="Plain-text answer (no Markdown, no HTML).")
    ]


class TagIn(BaseModel):
    model_config = ConfigDict(extra="forbid")

    slug: Annotated[
        str,
        Field(
            min_length=1,
            max_length=v.SLUG_MAX,
            description="English tag slug, a-z0-9 and hyphens (normalised), e.g. `subtitles`. Reuses the tag if it exists.",
        ),
    ]
    name: Annotated[
        str | None,
        Field(
            default=None,
            max_length=v.TAG_NAME_MAX,
            description="Display name, Thai welcome (e.g. `ซับไทย`). Needed only when the tag is new.",
        ),
    ] = None


class PostFields(BaseModel):
    """Every writable field. On update, omitted fields keep their value."""

    model_config = ConfigDict(extra="forbid")

    title: Annotated[str | None, Field(default=None, max_length=v.TITLE_MAX, description="Article title (the H1), Thai.")] = None
    meta_title: Annotated[
        str | None, Field(default=None, max_length=v.META_TITLE_MAX, description=f"SEO <title>, <= {v.META_TITLE_MAX} characters.")
    ] = None
    meta_description: Annotated[
        str | None,
        Field(default=None, max_length=v.META_DESCRIPTION_MAX, description=f"Meta description, <= {v.META_DESCRIPTION_MAX} characters."),
    ] = None
    excerpt: Annotated[
        str | None, Field(default=None, max_length=v.EXCERPT_MAX, description=f"Listing summary, <= {v.EXCERPT_MAX} characters.")
    ] = None
    content_md: Annotated[
        str | None,
        Field(
            default=None,
            max_length=v.CONTENT_MAX_CHARS,
            description=(
                "GitHub-flavoured Markdown body. Headings start at `##` (never `#`), no raw HTML, "
                "images only via `upload_image` URLs, at least 2 links to pages of this site."
            ),
        ),
    ] = None
    cover_image_url: Annotated[
        str | None, Field(default=None, max_length=500, description="A url returned by `upload_image`, or null for no cover.")
    ] = None
    cover_alt: Annotated[str | None, Field(default=None, max_length=v.ALT_MAX, description="Alt text for the cover image.")] = None
    category: Annotated[
        str | None, Field(default=None, max_length=80, description="An existing category slug (see `list_categories`).")
    ] = None
    tags: Annotated[
        list[TagIn] | None, Field(default=None, max_length=v.MAX_TAGS, description=f"Up to {v.MAX_TAGS} tags.")
    ] = None
    faq: Annotated[
        list[FaqItem] | None,
        Field(default=None, max_length=v.FAQ_MAX, description=f"{v.FAQ_MIN}–{v.FAQ_MAX} question/answer pairs."),
    ] = None


class NewPost(PostFields):
    slug: Annotated[
        str,
        Field(min_length=1, max_length=v.SLUG_MAX, description="URL slug: lowercase a-z, 0-9, single hyphens; <= 80 chars."),
    ]


class PostChanges(PostFields):
    new_slug: Annotated[
        str | None,
        Field(default=None, max_length=v.SLUG_MAX, description="Rename the slug — only before the post was ever published."),
    ] = None
