# spotify-cli

A CLI for controlling your Spotify playback.

This project was heavily inspired by [shpotify](https://github.com/hnarayanan/shpotify), but rewritten in typescript using bun. It uses Applescript for a lot of the interactions with Spotify, so it's only available on MacOS at the moment.

To install dependencies:

```bash
bun install
```

To run:

```bash
bun run spotify.ts
```

or

```
./spotify.ts
```

You can also build a self-contained binary with

```
bun run build
```

This project was created using `bun init` in bun v1.2.21. [Bun](https://bun.com) is a fast all-in-one JavaScript runtime.
