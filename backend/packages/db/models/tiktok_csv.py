from datetime import date, datetime

from sqlalchemy import BigInteger, Date, DateTime, Integer, Numeric, String, Text, UniqueConstraint, func
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.orm import Mapped, mapped_column

from packages.db.base import Base


class OverviewDaily(Base):
    __tablename__ = "overview_daily"
    __table_args__ = (
        UniqueConstraint("export_date", "date", name="uq_overview_daily_export_date_date"),
    )

    id: Mapped[int] = mapped_column(BigInteger, primary_key=True, autoincrement=True)
    export_date: Mapped[date] = mapped_column(Date, index=True)
    date: Mapped[date] = mapped_column(Date, index=True)
    video_views: Mapped[int] = mapped_column(Integer, default=0)
    profile_views: Mapped[int] = mapped_column(Integer, default=0)
    likes: Mapped[int] = mapped_column(Integer, default=0)
    comments: Mapped[int] = mapped_column(Integer, default=0)
    shares: Mapped[int] = mapped_column(Integer, default=0)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())


class VideoContent(Base):
    __tablename__ = "video_content"
    __table_args__ = (
        UniqueConstraint("export_date", "video_id", name="uq_video_content_export_date_video_id"),
    )

    id: Mapped[int] = mapped_column(BigInteger, primary_key=True, autoincrement=True)
    export_date: Mapped[date] = mapped_column(Date, index=True)
    video_id: Mapped[str] = mapped_column(String(64), index=True)
    video_url: Mapped[str] = mapped_column(String(512))
    video_title: Mapped[str] = mapped_column(Text)
    post_date: Mapped[date | None] = mapped_column(Date, nullable=True)
    likes: Mapped[int] = mapped_column(Integer, default=0)
    comments: Mapped[int] = mapped_column(Integer, default=0)
    shares: Mapped[int] = mapped_column(Integer, default=0)
    views: Mapped[int] = mapped_column(Integer, default=0)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())


class FollowerHistory(Base):
    __tablename__ = "follower_history"
    __table_args__ = (
        UniqueConstraint("export_date", "date", name="uq_follower_history_export_date_date"),
    )

    id: Mapped[int] = mapped_column(BigInteger, primary_key=True, autoincrement=True)
    export_date: Mapped[date] = mapped_column(Date, index=True)
    date: Mapped[date] = mapped_column(Date, index=True)
    followers: Mapped[int] = mapped_column(Integer, default=0)
    net_change: Mapped[int] = mapped_column(Integer, default=0)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())


class FollowerActivity(Base):
    __tablename__ = "follower_activity"
    __table_args__ = (
        UniqueConstraint(
            "export_date", "date", "hour",
            name="uq_follower_activity_export_date_date_hour",
        ),
    )

    id: Mapped[int] = mapped_column(BigInteger, primary_key=True, autoincrement=True)
    export_date: Mapped[date] = mapped_column(Date, index=True)
    date: Mapped[date] = mapped_column(Date, index=True)
    hour: Mapped[int] = mapped_column(Integer)
    active_followers: Mapped[int] = mapped_column(Integer, default=0)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())


class FollowerGender(Base):
    __tablename__ = "follower_gender"
    __table_args__ = (
        UniqueConstraint("export_date", "gender", name="uq_follower_gender_export_date_gender"),
    )

    id: Mapped[int] = mapped_column(BigInteger, primary_key=True, autoincrement=True)
    export_date: Mapped[date] = mapped_column(Date, index=True)
    gender: Mapped[str] = mapped_column(String(16))
    distribution: Mapped[float] = mapped_column(Numeric(6, 4))
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())


class FollowerTerritory(Base):
    __tablename__ = "follower_territory"
    __table_args__ = (
        UniqueConstraint(
            "export_date", "territory",
            name="uq_follower_territory_export_date_territory",
        ),
    )

    id: Mapped[int] = mapped_column(BigInteger, primary_key=True, autoincrement=True)
    export_date: Mapped[date] = mapped_column(Date, index=True)
    territory: Mapped[str] = mapped_column(String(16))
    distribution: Mapped[float] = mapped_column(Numeric(6, 4))
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())


class ViewersDaily(Base):
    __tablename__ = "viewers_daily"
    __table_args__ = (
        UniqueConstraint("export_date", "date", name="uq_viewers_daily_export_date_date"),
    )

    id: Mapped[int] = mapped_column(BigInteger, primary_key=True, autoincrement=True)
    export_date: Mapped[date] = mapped_column(Date, index=True)
    date: Mapped[date] = mapped_column(Date, index=True)
    total_viewers: Mapped[int | None] = mapped_column(Integer, nullable=True)
    new_viewers: Mapped[int | None] = mapped_column(Integer, nullable=True)
    returning_viewers: Mapped[int | None] = mapped_column(Integer, nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())


class CsvImportRun(Base):
    __tablename__ = "csv_import_runs"

    id: Mapped[int] = mapped_column(BigInteger, primary_key=True, autoincrement=True)
    export_date: Mapped[date] = mapped_column(Date, index=True)
    filenames: Mapped[list] = mapped_column(JSONB, default=list)
    status: Mapped[str] = mapped_column(String(16), default="running")  # running|ok|error
    rows_imported: Mapped[int] = mapped_column(Integer, default=0)
    error: Mapped[str | None] = mapped_column(Text, nullable=True)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), index=True
    )
