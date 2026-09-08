# Motion bridge (`tools/ardy/bridge.mjs`)

This is the loopback HTTP sidecar used by the Studio. It keeps the historical
`/ardy/*` route names so saved projects and motion URLs remain readable, but
the local Studio uses Kimodo for authored generation and GVHMR for video mocap
extraction. Legacy ARDY local/remote selection and its setup scripts are no
longer part of the bridge launch path.

Run it directly when debugging:

```bash
CCLAY_KIMODO_HOST=user@gpu-box node tools/ardy/bridge.mjs --port 5181
```

The sidecar owns health, base-listing, generation, footage download,
video-to-motion extraction, and allowlisted motion delivery. It binds to
`127.0.0.1`; the Vite dev server proxies only those API routes while serving
`public/ardy/` assets itself.

Kimodo settings:

| Variable | Default | Purpose |
| --- | --- | --- |
| `CCLAY_KIMODO_HOST` | required | SSH destination for the generation host |
| `CCLAY_KIMODO_REPO` | `$HOME/kimodo` | Kimodo checkout on that host |
| `CCLAY_KIMODO_MODEL` | `Kimodo-SOMA-RP-v1.1` | model identifier |
| `COZYCLAY_BRIDGE_PORT` | `5181` | loopback listen port |

Video mocap extraction requires `CCLAY_EXTRACT_BACKEND=gvhmr` (the default).
Any other backend or `CCLAY_EXTRACT_CMD` makes `/ardy/extract` return the named
`extract-backend-unsupported` error. Set `CCLAY_EXTRACT_HOST` (or
`CCLAY_ARDY_HOST`) to the GPU host that has the GVHMR checkout and virtualenv.

The wire path stays `/ardy` for backward compatibility; this does not
re-enable the removed ARDY backend.
