import asyncio
import sys
from packages.db.session import get_sessionmaker
from sqlalchemy import text

uid = sys.argv[1] if len(sys.argv) > 1 else "3f1d6dca-0368-4d45-a510-a115c3231fed"

async def check():
    maker = get_sessionmaker()
    session = maker()
    q = f"SELECT uid, mode, target_duration_sec, brief FROM tenant_default.video_projects WHERE uid = '{uid}'"
    result = await session.execute(text(q))
    row = result.fetchone()
    if row:
        print(f"uid={row[0]} mode={row[1]} target_duration_sec={row[2]}")
    await session.close()

asyncio.run(check())
