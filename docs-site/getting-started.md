# Getting started

Run the stable multi-architecture container:

```sh
docker run --rm -p 3000:3000 ghcr.io/erolsenol/image-craft-service:1.0.0
```

The API listens on port 3000. Check readiness and open the interactive API
reference:

```sh
curl http://localhost:3000/ready
open http://localhost:3000/docs
```

Transform a remote image (public internet hosts only; private and loopback
addresses are blocked):

```sh
curl -o photo.webp \
  'http://localhost:3000/v1/img/w_800,f_webp/https://example.com/photo.jpg'
```

`/v1` requires an API key when `API_KEYS` is configured. See
[configuration](configuration.md) for limits, authentication, cache, Redis,
storage, and plugins.
