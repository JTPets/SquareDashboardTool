# Troubleshooting

> **Navigation**: [Back to CLAUDE.md](../CLAUDE.md) | [Architecture](./ARCHITECTURE.md)
>
> **Last Updated**: 2026-04-01

---

## Common Issues

| Issue | Solution |
|-------|----------|
| "relation does not exist" | Run missing migration |
| "Cannot find module" | `npm install` |
| "merchant_id cannot be null" | Add `requireMerchant` middleware |
| Session issues after deploy | `pm2 restart sqtools` |
| Square API "ITEM_AT_LOCATION not found" | Use `POST /api/catalog-audit/enable-item-at-locations` to enable item at all active locations |

## View Logs

```bash
tail -f output/logs/app-*.log
tail -f output/logs/error-*.log
```
