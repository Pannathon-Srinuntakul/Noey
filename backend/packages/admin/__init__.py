"""The admin dashboard's backend: its own login (password + emailed code +
server-side sessions), the audit log, the owner-edited cost config, plan price
edits and the usage aggregates the dashboard computes money from.

Only services/api/routers/admin.py (and scripts) import this package.
"""
