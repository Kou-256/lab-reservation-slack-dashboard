# Security and sample data

This repository contains generic source code and synthetic test fixtures. Production credentials, real member names, reservation history, database backups, device enrollment keys, QR images and operational screenshots are excluded.

Configure your own Cloudflare account, D1 database, Slack app and secrets. Never commit .env, .dev.vars, backups, real member lists or device QR codes. Test identifiers and local placeholder values are not valid credentials.

Dashboard PINs are four digits and initially 0000. Users should change the initial PIN. Authentication is protected by device credentials and bounded failed attempts; it is intended for a shared internal terminal. PINs are stored as salted, server-keyed HMAC hashes. Device QR codes are credentials and must remain private.

CI runs tests, type checking and a frontend build. It does not deploy or access production services.
