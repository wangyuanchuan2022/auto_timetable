# dsh-timetable-reminder

## DSH bundle contract (must not regress)

A package listed in a profile's `dsh.profile.bundles` (see `~/.dsh/profiles/web/package.json`) is loaded by `dsh-app-boot` as a **patch layer**. It MUST declare a bundle manifest, or `dsh` fails at startup with:

```
dsh: profile bundle "dsh-timetable-reminder" declares no dsh.bundle in its package.json
```

Two required pieces (mirror `dsh-dafeiyu` / `dsh-pocket`):

1. `package.json` → `dsh.bundle.patch: "./cordis.patch.yml"` (plus keep `cordis.patch.yml` in `files` for publish).
2. A `cordis.patch.yml` at the package root that `insert`s the host plugin:

```yaml
- insert:
    - id: dsh-timetable-reminder
      name: dsh-timetable-reminder
```

The `id`/`name` must match the `name` exported by `src/index.js`. Do not add a `dsh.client` field — this plugin registers on the host only (Python helper subprocess), not in the web client.
