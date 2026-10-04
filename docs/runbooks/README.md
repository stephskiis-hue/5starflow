# Runbooks

- **Too many texts from 5StarFlow:** set `OWNER_SMS=off` in Railway, then check AI Command > Routines > `owner-daily-digest` and `sms-monitor` (only the digest may text the owner).
- **A routine got a 401:** the Claude environment has no credential. claude.ai > Routines > any routine > Edit > environment gear > Add credential (Bearer, header Authorization, the AI_TOKEN value, domain of the Railway app) and the variable `FIVESTARFLOW_URL`.
- **Inbound texts rejected (403):** `APP_URL` on Railway must equal the exact webhook URL configured in Twilio.
- **Facebook shifts did not run:** the Mac must be on with the Claude app open; check the `ext-social-mac` routine in AI Command.
- **Deploy:** merge to `main`; Railway runs `prisma migrate deploy` on start.
