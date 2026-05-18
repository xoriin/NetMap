## Icon Packs

Place pack files in this folder and register them in `index.json`.

### Quick import from exported SVGs

1. Export icons from your source pack as individual `.svg` files.
2. Put them in a local folder, for example `~/Downloads/my-icons`.
3. Run:

```bash
npm run import-icon-pack -- my-pack ~/Downloads/my-icons "My Pack"
```

This will:
- create `public/icon-packs/my-pack.json`
- add/update pack entry in `public/icon-packs/index.json`

Then select the pack in `Admin -> System -> Icon packs`.
