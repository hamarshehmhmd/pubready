# examples

`broken-release/` is a tiny package whose release workflow has the usual trusted-publishing mistakes
(no `id-token: write`, Node 20, a leftover `NODE_AUTH_TOKEN`, no `repository` in package.json). CI runs pubready
against it and checks it reports all of them:

```sh
npx github:hamarshehmhmd/pubready check examples/broken-release --offline --repo Acme/widget
```
