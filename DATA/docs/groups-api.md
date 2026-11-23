# Group API rate-limit notes

The Group API limiter is configurable and uses separate buckets for reads and mutations. `GET` and `HEAD` use per-user and per-source read buckets; every other method, including `POST`, `PUT`, `PATCH`, `DELETE`, and `OPTIONS`, uses the corresponding mutation buckets. Group creation and invitation creation also use their operation-specific limits. A limited request returns `429 RATE_LIMITED` and a whole-second `Retry-After` value.

## Docker development source address

In the Docker development environment, the Next.js proxy reaches DATA over loopback. DATA therefore sees `127.0.0.1` as the source for each request, and all users in one Compose project share each per-source bucket. Per-user buckets remain separate. A teammate testing with multiple browser profiles may reach a per-source `429` sooner than a deployment where users have different source addresses.

Forwarded headers such as `X-Forwarded-For`, `Forwarded`, and `X-Real-IP` do not change the source bucket. The development configuration keeps Express proxy trust disabled and leaves `AUTH_TRUST_PROXY_IPS` empty. Do not add a forwarded-header trust rule to work around a shared local bucket. The per-source limits are configurable through the Group API service options; tests inject a limiter so they do not consume production-style buckets.
