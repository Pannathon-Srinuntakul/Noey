"""Transactional email through SendGrid (plain httpx — no SDK).

- ``message``   — what an email is (addresses, subject, text + HTML) and the
  privacy helpers every log line uses (never a full address, never a token).
- ``sendgrid``  — the Mail Send v3 transport: tracking off, retries on 429/5xx.
- ``templates`` — the Thai copy, branded HTML with inline CSS + a plain-text part.
- ``client``    — whether email is configured, and the one mailer instance.

See docs/email-sendgrid.md.
"""
