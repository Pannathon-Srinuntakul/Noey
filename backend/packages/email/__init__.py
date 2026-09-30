"""Transactional email through SendGrid (plain httpx — no SDK).

- ``message``   — what an email is (addresses, subject, text + HTML) and the
  privacy helpers every log line uses (never a full address, never a token).
- ``sendgrid``  — the Mail Send v3 transport: tracking off, retries on 429/5xx.
- ``layout``    — the ONE shared layout (header, card, footer) + plain-text twin.
- ``templates`` — the Thai copy of each email, described as content blocks.
- ``client``    — whether email is configured, and the one mailer instance.

See docs/email-sendgrid.md.
"""
