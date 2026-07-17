# Third-party notices

serve-droid uses the following projects at runtime. Their source distributions remain governed
by their respective licenses.

- [scrcpy](https://github.com/Genymobile/scrcpy), Apache-2.0, Copyright Genymobile and Romain Vimont.
- [Tango ADB / ya-webadb](https://github.com/yume-chan/ya-webadb), MIT, Copyright yume-chan.
- [Model Context Protocol TypeScript SDK](https://github.com/modelcontextprotocol/typescript-sdk), MIT.
- React, Vite, Commander, ws, fast-xml-parser, sharp, and Zod under their published licenses.

The Android SDK Platform Tools are not redistributed. Users install them directly from Google.

The package includes the official `scrcpy-server` v3.3.3 binary, SHA-256
`7e70323ba7f259649dd4acce97ac4fefbae8102b2c6d91e2e7be613fd5354be0`. It is
uploaded temporarily to `/data/local/tmp` and removed by scrcpy cleanup when the session closes.
